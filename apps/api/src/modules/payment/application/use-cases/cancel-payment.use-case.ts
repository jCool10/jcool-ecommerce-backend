import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type TccBranchOutcome } from '@jcool/metrics-port';
import { cancelAction } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { callWithKeyRotation, voidKey, type KeyRotationDeps } from '../payment-idempotency-keys';
import type { CancelOutcome } from '../public/payment-participant.port';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type IntentStatus,
  type PaymentGatewayPort,
} from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';

const LOG_CONTEXT = 'CancelPayment';

type Settled = typeof PaymentStatus.EXPIRED | typeof PaymentStatus.VOIDED | typeof PaymentStatus.SUCCEEDED;

/** What the gateway confirmed for one payment, applied only if the row is still where it can move from. */
interface Settlement {
  paymentId: string;
  to: Settled;
  intentId?: string;
}

const SETTLES_FROM: Record<Settled, readonly PaymentStatus[]> = {
  [PaymentStatus.EXPIRED]: [PaymentStatus.PENDING],
  [PaymentStatus.VOIDED]: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED],
  // A void that found the money taken: recorded as the truth it is, and raised as a conflict.
  [PaymentStatus.SUCCEEDED]: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED],
};

type Answer = { outcome: CancelOutcome; branch: TccBranchOutcome };

/**
 * Flip-then-act: the header is closed and committed first, so an open racing this cancel always
 * sees it closed and expires its own session. The order's payments are then swept outside any
 * transaction and the confirmed results written back under the header lock. Every retry sweeps again.
 */
@Injectable()
export class CancelPaymentUseCase {
  private readonly keys: KeyRotationDeps;

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.keys = { txRunner, headers, payments };
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string): Promise<{ outcome: CancelOutcome }> {
    let answer: Answer;
    try {
      answer = await this.cancel(orderId);
    } catch (error) {
      this.metrics.recordTccBranch('payment', 'cancel', 'error');
      throw error;
    }
    this.metrics.recordTccBranch('payment', 'cancel', answer.branch);
    return { outcome: answer.outcome };
  }

  private async cancel(orderId: string): Promise<Answer> {
    const closed = await this.closeHeader(orderId);
    if (closed.outcome === 'CAPTURED_CONFLICT') {
      this.raiseConflict(orderId, 'header');
      return closed;
    }

    const attempts = await this.payments.findAllByOrderId(orderId);
    const settlements: Settlement[] = [];
    for (const payment of attempts) {
      const settlement = await this.release(payment);
      if (settlement !== null) settlements.push(settlement);
    }
    if (settlements.length > 0) await this.record(orderId, settlements);

    const voidFoundCapture = settlements.some((s) => s.to === PaymentStatus.SUCCEEDED);
    // A capture that landed after the flip left the header CANCELLED; only its payment tells a retry.
    if (voidFoundCapture || attempts.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
      this.raiseConflict(orderId, voidFoundCapture ? 'void' : 'payment');
      return { outcome: 'CAPTURED_CONFLICT', branch: 'conflict' };
    }
    return closed;
  }

  private closeHeader(orderId: string): Promise<Answer> {
    return this.txRunner.run(async (tx) => {
      let header = await this.headers.findForUpdate(tx, orderId);
      let fencedNow = false;
      if (header === null) {
        fencedNow = await this.headers.insertIfAbsent(tx, {
          orderId,
          status: PaymentOrderStatus.FENCED,
          amountMinor: null,
          currency: null,
        });
        // Lost to an open that inserted first: decide on the header it left.
        header = await this.headers.findForUpdate(tx, orderId);
      }
      const status = header?.status ?? PaymentOrderStatus.FENCED;

      switch (cancelAction(status)) {
        case 'captured_conflict':
          return { outcome: 'CAPTURED_CONFLICT', branch: 'conflict' };
        case 'cancel':
          await this.headers.updateStatus(tx, orderId, PaymentOrderStatus.CANCELLED, status);
          return { outcome: 'CANCELLED', branch: 'ok' };
        default:
          return {
            outcome: status === PaymentOrderStatus.FENCED ? 'FENCED' : 'CANCELLED',
            branch: fencedNow ? 'fenced' : 'idempotent',
          };
      }
    });
  }

  private async release(payment: Payment): Promise<Settlement | null> {
    switch (payment.status) {
      case PaymentStatus.PENDING: {
        const closed = await this.gateway.expireSession(payment.providerSessionId);
        if (closed !== 'already_completed') return { paymentId: payment.id as string, to: PaymentStatus.EXPIRED };
        // The buyer finished the page before it closed; whatever hold it placed is released here.
        const { intentId, intentStatus } = await this.gateway.retrieveAuthorization(payment.providerSessionId);
        return this.voidHold(payment, intentId, intentStatus);
      }
      case PaymentStatus.AUTHORIZED:
        return this.voidHold(payment, payment.providerIntentId ?? undefined, 'requires_capture');
      default:
        return null;
    }
  }

  private async voidHold(payment: Payment, intentId?: string, status?: IntentStatus): Promise<Settlement> {
    const paymentId = payment.id as string;
    if (intentId === undefined) {
      throw new PaymentGatewayError(`session ${payment.providerSessionId} completed but carries no intent yet`);
    }
    switch (status) {
      case 'canceled':
      case 'requires_payment_method':
        return { paymentId, to: PaymentStatus.VOIDED, intentId };
      case 'succeeded':
        return { paymentId, to: PaymentStatus.SUCCEEDED, intentId };
      case 'requires_capture':
        break;
      default:
        throw new PaymentGatewayError(`intent ${intentId} is ${status ?? 'unknown'}, not yet voidable`);
    }

    const outcome = await callWithKeyRotation(this.keys, payment, () => this.gateway.void(intentId, voidKey(payment)));
    return { paymentId, to: outcome === 'already_captured' ? PaymentStatus.SUCCEEDED : PaymentStatus.VOIDED, intentId };
  }

  private async record(orderId: string, settlements: Settlement[]): Promise<void> {
    await this.txRunner.run(async (tx) => {
      await this.headers.findForUpdate(tx, orderId);
      const locked = new Map((await this.payments.findAllByOrderId(orderId, tx)).map((p) => [p.id, p]));
      for (const { paymentId, to, intentId } of settlements) {
        const row = locked.get(paymentId);
        if (row === undefined || !SETTLES_FROM[to].includes(row.status)) continue;
        await this.payments.updateStatus(paymentId, to, {
          tx,
          expectedStatus: row.status,
          ...(intentId !== undefined && { providerIntentId: intentId }),
        });
      }
    });
  }

  private raiseConflict(orderId: string, foundBy: 'header' | 'void' | 'payment'): void {
    this.metrics.recordCaptureConflict();
    this.logger.error({ orderId, foundBy }, 'cancel found the order already captured — the buyer is owed a refund');
  }
}
