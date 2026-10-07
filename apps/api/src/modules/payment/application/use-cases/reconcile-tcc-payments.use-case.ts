import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { CANCELLED_PAYMENT_ORDER_STATUSES, type PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { callWithKeyRotation, voidKey, type KeyRotationDeps } from '../payment-idempotency-keys';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type SessionAuthorization } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { RecordAuthorizationUseCase } from './record-authorization.use-case';

const LOG_CONTEXT = 'ReconcileTccPayments';

export interface ReconcileTccInput {
  /** Rows touched more recently than this are left to the webhook still in flight, or to the last probe. */
  staleAfterSec: number;
  batchSize: number;
}

export interface ReconcileTccSummary {
  scanned: number;
  /** Holds the webhook never delivered, now recorded and announced. */
  authorized: number;
  expired: number;
  voided: number;
  /** Still undecided at Stripe; probed again once they are stale again. */
  undecided: number;
  /** Settled by a webhook or a cancel mid-probe, or refused by the recorder (it logs why). */
  skipped: number;
  /** A hold captured under a cancelled order — the buyer is owed a refund. */
  conflicts: number;
  errors: number;
}

type Outcome = Exclude<keyof ReconcileTccSummary, 'scanned' | 'errors'>;

type Settled = typeof PaymentStatus.EXPIRED | typeof PaymentStatus.VOIDED | typeof PaymentStatus.SUCCEEDED;

const COUNTED_AS = {
  [PaymentStatus.EXPIRED]: 'expired',
  [PaymentStatus.VOIDED]: 'voided',
  [PaymentStatus.SUCCEEDED]: 'conflicts',
} as const satisfies Record<Settled, Outcome>;

/**
 * The backstop behind the webhook and the cancel for payments under a header: records holds a lost
 * webhook never reported, settles sessions Stripe closed, and releases holds a cancel left behind.
 * Gateway I/O stays outside every transaction, and every write is compare-and-set on the status read.
 */
@Injectable()
export class ReconcileTccPaymentsUseCase {
  private readonly keys: KeyRotationDeps;

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    private readonly recordAuthorization: RecordAuthorizationUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.keys = { txRunner, headers, payments };
    logger.setContext(LOG_CONTEXT);
  }

  async execute({ staleAfterSec, batchSize }: ReconcileTccInput): Promise<ReconcileTccSummary> {
    const stale = await this.payments.findStaleTcc({
      untouchedSince: new Date(Date.now() - staleAfterSec * 1000),
      limit: batchSize,
    });
    const summary: ReconcileTccSummary = {
      scanned: stale.length,
      authorized: 0,
      expired: 0,
      voided: 0,
      undecided: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
    };

    for (const { payment, headerStatus } of stale) {
      const paymentId = payment.id as string;
      try {
        // Before the probe, so a row that throws or hangs still yields its turn to the rest.
        await this.payments.touch(paymentId);
        summary[await this.reconcileOne(payment, headerStatus)] += 1;
      } catch (error) {
        summary.errors += 1;
        this.logger.warn({ paymentId, orderId: payment.orderId, err: toError(error) }, 'reconcile failed for payment');
      }
    }
    return summary;
  }

  private async reconcileOne(payment: Payment, headerStatus: PaymentOrderStatus): Promise<Outcome> {
    // The stale query only returns an authorized payment once its header is closed.
    if (payment.status === PaymentStatus.AUTHORIZED) return this.releaseHold(payment);

    const found = await this.gateway.retrieveAuthorization(payment.providerSessionId);
    if (found.intentStatus === 'requires_capture') return this.recordHold(payment, found);
    if (found.sessionStatus === 'expired') return this.settle(payment, PaymentStatus.EXPIRED);
    if (found.sessionStatus === 'complete' && found.intentStatus === 'canceled') {
      return this.settle(payment, PaymentStatus.VOIDED, found.intentId);
    }
    if (found.sessionStatus === 'open' && CANCELLED_PAYMENT_ORDER_STATUSES.includes(headerStatus)) {
      // An open that lost to a cancel and then failed to close its own session.
      const closed = await this.gateway.expireSession(payment.providerSessionId);
      // A buyer who finished the page meanwhile placed a hold: the next probe records it, then releases it.
      if (closed !== 'already_completed') return this.settle(payment, PaymentStatus.EXPIRED);
    }
    return 'undecided';
  }

  private async recordHold(payment: Payment, authorization: SessionAuthorization): Promise<Outcome> {
    const outboxId = await mintOne(this.idGenerator);
    const recorded = await this.txRunner.run((tx) =>
      this.recordAuthorization.execute(tx, {
        orderId: payment.orderId,
        providerSessionId: payment.providerSessionId,
        authorization,
        authorizedAt: new Date(),
        outboxId,
      }),
    );
    return recorded.outcome === 'authorized' ? 'authorized' : 'skipped';
  }

  private async releaseHold(payment: Payment): Promise<Outcome> {
    const intentId = payment.providerIntentId;
    if (intentId === null) throw new Error(`authorized payment ${payment.id} carries no intent`);

    const outcome = await callWithKeyRotation(this.keys, payment, () => this.gateway.void(intentId, voidKey(payment)));
    // Recorded as the truth it is, which also takes the row out of the stale queue: the alarm fires once.
    return this.settle(payment, outcome === 'already_captured' ? PaymentStatus.SUCCEEDED : PaymentStatus.VOIDED);
  }

  private async settle(payment: Payment, to: Settled, intentId?: string): Promise<Outcome> {
    const written = await this.payments.updateStatus(payment.id as string, to, {
      expectedStatus: payment.status,
      // Fills a gap only; a handle already on the row came from the recorder and stays.
      ...(payment.providerIntentId === null && intentId !== undefined && { providerIntentId: intentId }),
    });
    if (written === null) return 'skipped';
    if (to === PaymentStatus.SUCCEEDED) {
      this.metrics.recordCaptureConflict();
      this.logger.error(
        { orderId: payment.orderId, paymentId: payment.id },
        'reconcile found a hold captured under a cancelled order — the buyer is owed a refund',
      );
    }
    return COUNTED_AS[to];
  }
}
