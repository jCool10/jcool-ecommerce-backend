import { Inject, Injectable } from '@nestjs/common';
import { PaymentStatus } from '../../domain/payment-status';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { mapEventToOutcome } from '../mappers/map-event-to-outcome';
import { readCheckoutSession } from '../mappers/read-checkout-session';
import { ProcessTccWebhookEventUseCase, type TccWebhookResult } from './process-tcc-webhook-event.use-case';

/**
 * `rejected` is the only non-2xx result (verify failed, nothing persisted); every other outcome means
 * the event was accepted and logged, so the gateway gets a 2xx and stops retrying.
 */
export type WebhookProcessResult =
  | { outcome: 'rejected'; reason: 'invalid_signature' | 'expired_timestamp' }
  | { outcome: 'duplicate'; providerEventId: string; eventType: string }
  | { outcome: 'ignored'; providerEventId: string; eventType: string }
  // A session no `payment_orders` header owns, so no saga will ever capture or void it.
  | {
      outcome: 'skipped';
      reason: 'no_payment_header';
      providerEventId: string;
      eventType: string;
      sessionId: string | null;
      moneyMoved: boolean;
    };

/**
 * Participant payments go to the TCC path. Anything else is only logged: nothing here changes a
 * payment or an order any more.
 */
@Injectable()
export class ProcessWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEventRepo: WebhookEventRepositoryPort,
    private readonly tccWebhookEvent: ProcessTccWebhookEventUseCase,
  ) {}

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult | TccWebhookResult> {
    // Verify BEFORE any DB write — a forged or replayed body must never reach the event log.
    const verified = this.paymentGateway.verifyAndParseEvent(rawBody, headers);
    if (verified.kind !== 'valid') {
      return { outcome: 'rejected', reason: verified.kind };
    }
    const tcc = await this.tccWebhookEvent.execute(verified);
    if (tcc) return tcc;

    const delivery = { providerEventId: verified.providerEventId, eventType: verified.type };

    return this.transactionRunner.run(async (tx) => {
      const { inserted, event } = await this.webhookEventRepo.insertIfNew(
        {
          provider: this.paymentGateway.provider,
          providerEventId: verified.providerEventId,
          type: verified.type,
          payload: verified.payload,
        },
        tx,
      );
      if (!inserted) return { outcome: 'duplicate', ...delivery };
      if (event.id === null) throw new Error('inserted webhook_events row has no id');

      const facts = readCheckoutSession(verified.payload);
      const outcome = mapEventToOutcome(verified.type, facts.paymentStatus);
      // Left RECEIVED, not skipped: logged for audit, never a candidate for application.
      if (outcome.kind === 'ignore') return { outcome: 'ignored', ...delivery };

      await this.webhookEventRepo.markSkipped(event.id, tx);
      return {
        outcome: 'skipped',
        reason: 'no_payment_header',
        ...delivery,
        sessionId: facts.sessionId ?? null,
        // `no_payment_required` also settles as succeeded, but nothing was charged.
        moneyMoved:
          facts.paymentStatus === 'paid' && outcome.kind === 'settle' && outcome.status === PaymentStatus.SUCCEEDED,
      };
    });
  }
}
