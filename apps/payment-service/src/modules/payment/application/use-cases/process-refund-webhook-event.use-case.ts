import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleTx } from '../../../../database';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import type { RefundSettlement } from '../../domain/refund-settlement';
import { applyRefundSettlement } from '../apply-refund-settlement';
import { readRefundEvent, REFUND_EVENT_TYPES } from '../mappers/read-refund-event';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '../ports/id-generator.port';
import {
  PAYMENT_GATEWAY,
  type PaymentGatewayPort,
  type ProviderRefund,
  type VerifiedEvent,
} from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import {
  PAYMENT_REFUND_REPOSITORY,
  type PaymentRefund,
  type PaymentRefundRepositoryPort,
} from '../ports/payment-refund-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';

const LOG_CONTEXT = 'ProcessRefundWebhookEvent';

type ValidEvent = Extract<VerifiedEvent, { kind: 'valid' }>;

export type RefundWebhookSkip =
  | 'no_refund_id'
  | 'unknown_intent'
  | 'not_captured'
  | 'currency_mismatch'
  | 'metadata_mismatch'
  | 'untracked'
  | 'unbound'
  | 'still_pending'
  | 'already_settled';

export interface RefundWebhookResult {
  path: 'refund';
  outcome: 'duplicate' | 'skipped' | 'processed';
  reason?: RefundWebhookSkip;
  orderId: string | null;
  refundId: string | null;
  providerEventId: string;
  eventType: string;
}

type Applied = Pick<RefundWebhookResult, 'outcome' | 'reason'>;

/** What the transaction decided, acted on (counted, logged) only once it committed. */
type Effect = { kind: 'settled'; settlement: RefundSettlement; row: PaymentRefund } | { kind: 'untracked' };

/**
 * `refund.*` events. Only the refund id is read from the body; the refund itself is read back from
 * Stripe before anything is written, so a redelivered or out-of-order event cannot undo a newer state.
 * The refund binds to its order through the PaymentIntent the captured attempt recorded, never through
 * metadata, which a dashboard refund lacks; metadata naming another order stops the write.
 */
@Injectable()
export class ProcessRefundWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_REFUND_REPOSITORY) private readonly refunds: PaymentRefundRepositoryPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** Null when the event is not about a refund. */
  async execute(event: ValidEvent): Promise<RefundWebhookResult | null> {
    if (!REFUND_EVENT_TYPES.has(event.type)) return null;
    const delivery = { path: 'refund', providerEventId: event.providerEventId, eventType: event.type } as const;

    const { refundId } = readRefundEvent(event.payload);
    if (!refundId) {
      this.logger.warn(delivery, 'refund event names no refund');
      return { ...delivery, orderId: null, refundId: null, ...(await this.skipped(event, 'no_refund_id')) };
    }

    // A failure here leaves no webhook_events row, so Stripe's redelivery gets a clean run.
    const reported = await this.gateway.retrieveRefund(refundId);
    const payment = reported.intentId ? await this.payments.findByProviderIntentId(reported.intentId) : null;
    const located = { ...delivery, refundId, orderId: payment?.orderId ?? null };
    const unbound = this.unboundReason(payment, reported, refundId);
    if (unbound) return { ...located, ...(await this.skipped(event, unbound)) };

    const orderId = (payment as Payment).orderId;
    const eventId = await mintOne(this.idGenerator);
    let effect: Effect | undefined;
    const applied = await this.logged(event, eventId, async (tx) => {
      const decided = await this.settle(tx, orderId, reported, refundId);
      effect = decided.effect;
      return decided.applied;
    });

    if (effect?.kind === 'settled' && effect.settlement.owed) this.reportOwed(orderId, effect.row, effect.settlement);
    if (effect?.kind === 'untracked') this.reportUntracked(orderId, reported, refundId);
    return { ...located, ...applied };
  }

  /** Why the refund cannot be bound to an order's captured charge, if it cannot. */
  private unboundReason(payment: Payment | null, reported: ProviderRefund, refundId: string): RefundWebhookSkip | null {
    if (!payment) {
      this.logger.info({ refundId, intentId: reported.intentId }, 'refund of a charge no attempt here made');
      return 'unknown_intent';
    }
    const context = { orderId: payment.orderId, refundId, intentId: reported.intentId };
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      this.logger.warn({ ...context, paymentStatus: payment.status }, 'refund of an attempt not recorded as captured');
      return 'not_captured';
    }
    if (reported.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      this.logger.error(
        { ...context, currency: reported.currency, chargeCurrency: payment.currency },
        'refund currency differs from the captured charge',
      );
      return 'currency_mismatch';
    }
    if (reported.metadataOrderId !== null && reported.metadataOrderId !== payment.orderId) {
      this.logger.error(
        { ...context, metadataOrderId: reported.metadataOrderId },
        'refund metadata names another order',
      );
      return 'metadata_mismatch';
    }
    return null;
  }

  private async settle(
    tx: DrizzleTx,
    orderId: string,
    reported: ProviderRefund,
    refundId: string,
  ): Promise<{ applied: Applied; effect?: Effect }> {
    const header = await this.headers.findForUpdate(tx, orderId);
    const recorded = await this.refunds.findByProviderRefundId(refundId, tx);
    if (recorded && recorded.orderId !== orderId) {
      throw new Error(`refund ${refundId} is recorded on order ${recorded.orderId}, its charge belongs to ${orderId}`);
    }
    const row = recorded ?? (await this.refunds.findByOrderId(orderId, tx));

    const covering = row?.coveredRefundIds.includes(refundId) ?? false;
    // The command's own refund reported before the command recorded its id, or one made elsewhere the
    // command would adopt. A failed one made elsewhere never stands for the order's refund: it returned
    // nothing, while the shop's own refund may well succeed.
    const awaitingId =
      header?.status === PaymentOrderStatus.REFUNDING &&
      row?.providerRefundId === null &&
      row.coveredRefundIds.length === 0 &&
      row.amountMinor === reported.amountMinor &&
      (reported.metadataOrderId === orderId || !isFailedReport(reported));
    if (header && row && (recorded || covering || awaitingId)) {
      const settlement = await applyRefundSettlement(
        tx,
        { headers: this.headers, refunds: this.refunds },
        header.status,
        row,
        reported,
      );
      const moved = settlement.header !== undefined || settlement.refund !== undefined;
      const unmoved = settlement.outcome === 'PENDING' ? 'still_pending' : 'already_settled';
      return {
        applied: moved ? { outcome: 'processed' } : { outcome: 'skipped', reason: unmoved },
        effect: { kind: 'settled', settlement, row },
      };
    }
    if (header?.status === PaymentOrderStatus.CAPTURED && !row) {
      return { applied: { outcome: 'skipped', reason: 'untracked' }, effect: { kind: 'untracked' } };
    }

    this.logger.warn(
      { orderId, refundId, header: header?.status ?? null, recordedRefundId: row?.providerRefundId ?? null },
      'refund event matches no refund the shop is waiting on',
    );
    return { applied: { outcome: 'skipped', reason: 'unbound' } };
  }

  private async skipped(event: ValidEvent, reason: RefundWebhookSkip): Promise<Applied> {
    const eventId = await mintOne(this.idGenerator);
    return this.logged(event, eventId, () => Promise.resolve({ outcome: 'skipped', reason }));
  }

  /** Logs the event and applies it in one transaction; a duplicate delivery applies nothing. */
  private logged(event: ValidEvent, eventId: string, apply: (tx: DrizzleTx) => Promise<Applied>): Promise<Applied> {
    return this.transactionRunner.run(async (tx) => {
      const { inserted } = await this.webhookEvents.insertIfNew(
        {
          id: eventId,
          provider: this.gateway.provider,
          providerEventId: event.providerEventId,
          type: event.type,
          payload: event.payload,
        },
        tx,
      );
      if (!inserted) return { outcome: 'duplicate' };

      const applied = await apply(tx);
      if (applied.outcome === 'processed') {
        await this.webhookEvents.markProcessed(eventId, tx);
      } else {
        await this.webhookEvents.markSkipped(eventId, tx);
      }
      return applied;
    });
  }

  private reportOwed(orderId: string, row: PaymentRefund, settlement: RefundSettlement): void {
    this.metrics.recordRefundOwed('refund_failed');
    this.logger.error(
      { orderId, paymentId: row.paymentId, amountMinor: row.amountMinor, reason: settlement.reason },
      'Stripe failed the refund — refund owed',
    );
  }

  private reportUntracked(orderId: string, reported: ProviderRefund, refundId: string): void {
    this.metrics.recordRefundUntracked();
    this.logger.error(
      { orderId, refundId, amountMinor: reported.amountMinor, status: reported.status },
      'refund issued outside the shop',
    );
  }
}

function isFailedReport(reported: ProviderRefund): boolean {
  return reported.status === 'failed' || reported.status === 'canceled';
}
