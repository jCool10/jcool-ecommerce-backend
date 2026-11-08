import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleTx } from '../../../../database';
import { decidePaymentOrderOp } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import type { Payment } from '../../domain/payment.entity';
import type { RefundSettlement } from '../../domain/refund-settlement';
import { applyRefundSettlement } from '../apply-refund-settlement';
import { withIntentKey } from '../intent-idempotency-key';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '../ports/id-generator.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type ProviderRefund } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import {
  PAYMENT_REFUND_REPOSITORY,
  type PaymentRefund,
  type PaymentRefundRepositoryPort,
} from '../ports/payment-refund-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import type { RefundResult } from '../public/payment-participant.port';

const LOG_CONTEXT = 'RefundPayment';

type Started = { kind: 'answered'; result: RefundResult } | { kind: 'drive'; payment: Payment; refund: PaymentRefund };

/**
 * Flip-then-act, like cancel: tx1 moves the header to REFUNDING and writes the refund row, Stripe is
 * called with no transaction open, tx2 settles what Stripe reported. The REFUNDING header is what
 * fences a second refund, and what a call after a crash resumes from, with the same key and actor.
 */
@Injectable()
export class RefundPaymentUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_REFUND_REPOSITORY) private readonly refunds: PaymentRefundRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string, requestedBy: string): Promise<RefundResult> {
    const header = await this.headers.find(orderId);
    const decision = decidePaymentOrderOp('refund', header?.status ?? null);
    if (decision !== 'refund' && decision !== 'resume') return this.answer(decision, orderId);

    // Minted before the lock, never under it; wasted when the order turns out to be resumed.
    const refundId = decision === 'refund' ? await mintOne(this.idGenerator) : null;
    const started = await this.transactionRunner.run((tx) => this.start(tx, orderId, requestedBy, refundId));
    if (started.kind === 'answered') return started.result;

    const { payment, refund } = started;
    if (refund.requestedBy !== requestedBy) {
      this.logger.info(
        { orderId, requestedBy, recordedBy: refund.requestedBy },
        'refund asked again by another admin; the first one stays recorded',
      );
    }
    const reported = await this.ask(payment, refund);
    const settlement = await this.transactionRunner.run((tx) => this.record(tx, orderId, reported));
    if (settlement.owed) this.reportOwed(orderId, refund, settlement);
    return resultOf(settlement);
  }

  private async start(tx: DrizzleTx, orderId: string, requestedBy: string, refundId: string | null): Promise<Started> {
    const header = await this.headers.findForUpdate(tx, orderId);
    const decision = decidePaymentOrderOp('refund', header?.status ?? null);
    if (decision !== 'refund' && decision !== 'resume') {
      return { kind: 'answered', result: await this.answer(decision, orderId, tx) };
    }

    const payment = await this.payments.findSucceededByOrderId(orderId, tx);
    if (!payment?.providerIntentId) {
      throw new Error(`order ${orderId} reads ${header?.status} but has no captured payment with an intent`);
    }
    // A concurrent call that read CAPTURED before this one flipped the header resumes this row.
    if (decision === 'refund' && refundId !== null) {
      const inserted = await this.refunds.insert(tx, {
        id: refundId,
        orderId,
        paymentId: payment.id as string,
        requestedBy,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      });
      if (!inserted) this.logger.error({ orderId }, 'a refund row already existed under a CAPTURED header');
      await this.headers.update(tx, orderId, { status: PaymentOrderStatus.REFUNDING });
    }
    const refund = await this.refunds.findByOrderId(orderId, tx);
    if (!refund) throw new Error(`order ${orderId} reads REFUNDING but has no refund row`);
    return { kind: 'drive', payment, refund };
  }

  private async ask(payment: Payment, refund: PaymentRefund): Promise<ProviderRefund> {
    const intentId = payment.providerIntentId as string;
    const reported = refund.providerRefundId
      ? await this.gateway.retrieveRefund(refund.providerRefundId)
      : await withIntentKey(this.payments, payment, 'refund', (key) =>
          this.gateway.refundIntent(
            {
              intentId,
              amountMinor: refund.amountMinor,
              currency: refund.currency,
              orderId: refund.orderId,
              requestedBy: refund.requestedBy,
            },
            key,
          ),
        );

    // The adapter already lists by intent; this keeps any other gateway to the same binding.
    if (
      reported.intentId !== intentId ||
      reported.amountMinor !== refund.amountMinor ||
      reported.currency.toUpperCase() !== refund.currency.toUpperCase()
    ) {
      this.logger.error(
        { orderId: refund.orderId, refundId: reported.refundId, intentId: reported.intentId },
        'refund reported by the gateway does not match the captured charge',
      );
      throw new Error(`refund ${reported.refundId ?? '(none)'} does not match order ${refund.orderId}'s charge`);
    }
    if (reported.coveredBy) {
      this.logger.warn(
        { orderId: refund.orderId, refundIds: reported.coveredBy },
        'charge already refunded in full by several refunds made elsewhere; adopted without a second refund',
      );
    }
    return reported;
  }

  private async record(tx: DrizzleTx, orderId: string, reported: ProviderRefund): Promise<RefundSettlement> {
    const header = await this.headers.findForUpdate(tx, orderId);
    const row = await this.refunds.findByOrderId(orderId, tx);
    if (!header || !row) throw new Error(`order ${orderId} lost its header or refund row under the lock`);
    return applyRefundSettlement(tx, { headers: this.headers, refunds: this.refunds }, header.status, row, reported);
  }

  private async answer(
    decision: 'idempotent' | 'failed' | 'not_refundable',
    orderId: string,
    tx?: DrizzleTx,
  ): Promise<RefundResult> {
    switch (decision) {
      case 'idempotent':
        return { outcome: 'IDEMPOTENT' };
      case 'not_refundable':
        return { outcome: 'NOT_REFUNDABLE' };
      case 'failed': {
        const reason = (await this.refunds.findByOrderId(orderId, tx))?.failureReason;
        return reason ? { outcome: 'REFUND_FAILED', reason } : { outcome: 'REFUND_FAILED' };
      }
    }
  }

  private reportOwed(orderId: string, refund: PaymentRefund, settlement: RefundSettlement): void {
    this.metrics.recordRefundOwed('refund_failed');
    this.logger.error(
      { orderId, paymentId: refund.paymentId, amountMinor: refund.amountMinor, reason: settlement.reason },
      'Stripe failed the refund — refund owed',
    );
  }
}

function resultOf({ outcome, reason }: RefundSettlement): RefundResult {
  return outcome === 'REFUND_FAILED' && reason !== undefined ? { outcome, reason } : { outcome };
}
