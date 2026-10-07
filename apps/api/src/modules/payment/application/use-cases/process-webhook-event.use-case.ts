import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { PaymentStatus } from '../../domain/payment-status';
import { canTransition } from '../../domain/payment-state-machine';
import type { Payment } from '../../domain/payment.entity';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type VerifiedEvent } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { chargeMatchesPayment } from '../mappers/charge-matches-payment';
import { mapEventToOutcome } from '../mappers/map-event-to-outcome';
import { readCheckoutSession } from '../mappers/read-checkout-session';
import { toSettledOutboxRecord } from '../payment-outbox.mapper';
import { ApplyTccWebhookEventUseCase } from './apply-tcc-webhook-event.use-case';
import type { WebhookProcessResult } from './webhook-process-result';

export type { WebhookProcessResult } from './webhook-process-result';

const SESSION_EVENTS = new Set(['checkout.session.completed', 'checkout.session.expired']);

/**
 * Applies a verified webhook to the payment side only. The idempotency insert and the payment change
 * share ONE transaction: split them, and a crash after logging the event but before applying it leaves
 * the redelivery seeing `inserted: false` and no-oping forever.
 */
@Injectable()
export class ProcessWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEventRepo: WebhookEventRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly paymentRepo: PaymentRepositoryPort,
    @Inject(OUTBOX_WRITER) private readonly outboxWriter: OutboxWriterPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly paymentOrders: PaymentOrderRepositoryPort,
    private readonly applyTccEvent: ApplyTccWebhookEventUseCase,
  ) {}

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult> {
    // Verify BEFORE any DB write — a forged or replayed body must never reach the event log.
    const verified = this.paymentGateway.verifyAndParseEvent(rawBody, headers);
    if (verified.kind !== 'valid') {
      return { outcome: 'rejected', reason: verified.kind };
    }
    const delivery = { providerEventId: verified.providerEventId, eventType: verified.type };

    const fenced = await this.findFencedPayment(verified);
    if (fenced !== null) return this.applyTccEvent.execute(verified, fenced);

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

      const eventId = event.id;
      if (eventId === null) throw new Error('inserted webhook_events row has no id');

      const facts = readCheckoutSession(verified.payload);
      const settlement = mapEventToOutcome(verified.type, facts.paymentStatus);
      // Left RECEIVED, not skipped: logged for audit, never a candidate for application.
      if (settlement.kind === 'ignore') return { outcome: 'ignored', ...delivery };

      // The session finished but the money has not cleared. Leaving the payment PENDING is the whole
      // point: the sweep settles it once the gateway reports it paid, and never before.
      if (settlement.kind === 'awaiting_payment') {
        await this.webhookEventRepo.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'awaiting_payment', ...delivery };
      }

      const target = settlement.status;
      const payment = facts.sessionId ? await this.paymentRepo.findByProviderSessionId(facts.sessionId, tx) : null;
      // The webhook raced ahead of our own commit, or carries a shape we don't link to a payment.
      // Keep the audit row and skip applying; the sweep settles the order either way.
      if (!payment || payment.id === null) {
        await this.webhookEventRepo.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'payment_not_found', ...delivery };
      }

      // Only a success moves money, so only a success has to prove it moved OUR money.
      if (target === PaymentStatus.SUCCEEDED && !chargeMatchesPayment(payment, facts)) {
        await this.webhookEventRepo.markSkipped(eventId, tx);
        return {
          outcome: 'skipped',
          reason: 'amount_mismatch',
          ...delivery,
          charge: {
            orderId: payment.orderId,
            expectedMinor: payment.amountMinor,
            expectedCurrency: payment.currency,
            actualMinor: facts.amountMinor,
            actualCurrency: facts.currency,
          },
        };
      }

      // The outcome this payment already settled to (reconcile got there first): a no-op, not a
      // conflict that books a refund.
      if (payment.status === target) {
        await this.webhookEventRepo.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'already_settled', ...delivery };
      }

      // Out-of-order or terminal-state event: refuse it in the domain rather than clobber a settled
      // payment. The read's FOR UPDATE lock makes the guard hold under concurrent distinct events.
      if (!canTransition(payment.status, target)) {
        await this.webhookEventRepo.markSkipped(eventId, tx);
        return {
          outcome: 'skipped',
          reason: 'conflict',
          ...delivery,
          conflict: { orderId: payment.orderId, from: payment.status, to: target },
        };
      }

      const applied =
        target === PaymentStatus.SUCCEEDED ? payment.markSucceeded(facts.intentId) : payment.markFailed(facts.intentId);
      const updated = await this.paymentRepo.updateStatus(payment.id, applied.status, {
        providerIntentId: applied.providerIntentId,
        tx,
      });
      // The row was just read+locked in this tx, so a null update is an invariant break, not a
      // missing payment — throw to roll the whole unit back rather than falsely mark it PROCESSED.
      if (!updated) throw new Error(`payment vanished mid-transaction: ${payment.id}`);
      await this.webhookEventRepo.markProcessed(eventId, tx);

      // Same tx as the settlement, so a settled payment can never lose the event that drives its order
      // — the crash window the direct call in HandlePaymentWebhookUseCase cannot close, since that one
      // runs after this commit. It publishes what happened to the money, not what the order becomes.
      await this.outboxWriter.append(
        tx,
        toSettledOutboxRecord({
          paymentId: payment.id,
          orderId: payment.orderId,
          status: target,
          paymentRef: applied.providerIntentId,
          settledAt: new Date(),
        }),
      );

      return {
        outcome: 'processed',
        status: applied.status,
        orderId: payment.orderId,
        paymentRef: applied.providerIntentId,
        eventType: verified.type,
      };
    });
  }

  /** A payment opened behind a header never takes the settlement path below, whatever the event says. */
  private async findFencedPayment(event: Extract<VerifiedEvent, { kind: 'valid' }>): Promise<Payment | null> {
    if (!SESSION_EVENTS.has(event.type)) return null;
    const { sessionId } = readCheckoutSession(event.payload);
    const payment = sessionId ? await this.paymentRepo.findByProviderSessionId(sessionId) : null;
    if (payment === null) return null;
    return (await this.paymentOrders.find(payment.orderId)) === null ? null : payment;
  }
}
