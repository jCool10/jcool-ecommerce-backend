import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { assertPositive, Money, toError } from '@jcool/kernel';
import { METRICS, type MetricsPort, type TccBranchOutcome } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { openSessionAction } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import { Payment } from '../../domain/payment.entity';
import type { OpenSessionInput, OpenSessionResult } from '../public/payment-participant.port';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type GatewaySession,
  type PaymentGatewayPort,
} from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';

const LOG_CONTEXT = 'OpenPaymentSession';

/** Two opens for one order both reached the gateway; the loser's session is closed and the call retried. */
export class ConcurrentSessionOpenError extends Error {
  constructor(orderId: string) {
    super(`another session was recorded for order ${orderId} while this one was being opened`);
    this.name = 'ConcurrentSessionOpenError';
  }
}

type Opened = Extract<OpenSessionResult, { outcome: 'OPENED' }>;
type Answer = { result: OpenSessionResult; branch: TccBranchOutcome };

const CLOSED = (branch: TccBranchOutcome): Answer => ({ result: { outcome: 'CLOSED' }, branch });

/**
 * Act-then-check against the header: the session is created between two transactions, and the second
 * one decides whether it may stand. A cancel that flips the header in between leaves this call to
 * close the session it just opened, since that cancel could not see it.
 */
@Injectable()
export class OpenPaymentSessionUseCase {
  private readonly floorMs: number;

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.floorMs =
      (requireIntConfig(config, 'payment.sessionMinTtlSec', 0) +
        requireIntConfig(config, 'payment.sessionExpiryMarginSec', 0)) *
      1000;
    logger.setContext(LOG_CONTEXT);
  }

  async execute(input: OpenSessionInput): Promise<OpenSessionResult> {
    let answer: Answer;
    try {
      answer = await this.open(input);
    } catch (error) {
      this.metrics.recordTccBranch('payment', 'open_session', 'error');
      throw error;
    }
    this.metrics.recordTccBranch('payment', 'open_session', answer.branch);
    return answer.result;
  }

  private async open({ orderId, amountMinor, currency, expiresAt }: OpenSessionInput): Promise<Answer> {
    if (expiresAt.getTime() < Date.now() + this.floorMs) return CLOSED('rejected');
    // The first open fixes the order's amount on the header, so a bad one must not get that far.
    assertPositive(amountMinor, 'amountMinor');
    const money = Money.of(amountMinor, currency);

    const fenced = await this.txRunner.run(async (tx) => {
      await this.headers.insertIfAbsent(tx, {
        orderId,
        status: PaymentOrderStatus.OPEN,
        amountMinor: money.amountMinor,
        currency: money.currency,
      });
      const header = await this.headers.findForUpdate(tx, orderId);
      if (header === null || openSessionAction(header.status) !== 'open') return { kind: 'closed' } as const;
      if (header.amountMinor !== money.amountMinor || header.currency !== money.currency) {
        return { kind: 'mismatch', header } as const;
      }
      return { kind: 'open', active: await this.payments.findActiveByOrderIdForUpdate(tx, orderId) } as const;
    });

    if (fenced.kind === 'closed') return CLOSED('conflict');
    if (fenced.kind === 'mismatch') {
      this.logger.error(
        {
          orderId,
          opened: [fenced.header.amountMinor, fenced.header.currency],
          asked: [money.amountMinor, money.currency],
        },
        'open asked for different money than the order was first opened for',
      );
      return CLOSED('rejected');
    }

    let retiring: Payment | null = null;
    if (fenced.active !== null) {
      if (fenced.active.status !== PaymentStatus.PENDING) {
        // A hold released out of band (dashboard, lapsed authorization) still fills the one active slot.
        this.logger.warn(
          { orderId, paymentId: fenced.active.id, status: fenced.active.status },
          'order already has a settled attempt under an open header',
        );
        return CLOSED('conflict');
      }
      const reused = await this.reuse(fenced.active);
      if (reused !== null) return { result: reused, branch: 'idempotent' };
      retiring = fenced.active;
    }

    // Before the session: an id-service fault after it would leave that session with no row.
    const [paymentId] = await this.idGenerator.mint(1);
    const session = await this.gateway.createSession({
      orderId,
      amountMinor: money.amountMinor,
      currency: money.currency,
      idempotencyKey: uuidv7(),
      captureMethod: 'manual',
      expiresAt,
    });

    const placed = await this.txRunner.run(async (tx) => {
      const header = await this.headers.findForUpdate(tx, orderId);
      if (retiring !== null) {
        await this.payments.updateStatus(retiring.id as string, retiring.markFailed().status, {
          tx,
          expectedStatus: PaymentStatus.PENDING,
        });
      }
      if ((await this.payments.findActiveByOrderIdForUpdate(tx, orderId)) !== null) {
        return { headerStatus: header?.status, payment: null };
      }
      const payment = await this.payments.create(
        Payment.create({
          orderId,
          provider: this.gateway.provider,
          providerSessionId: session.providerSessionId,
          amountMinor: money.amountMinor,
          currency: money.currency,
        }),
        tx,
        paymentId,
      );
      return { headerStatus: header?.status, payment };
    });

    if (placed.headerStatus === PaymentOrderStatus.OPEN && placed.payment !== null) {
      return { result: opened(placed.payment, session), branch: 'ok' };
    }
    await this.closeUnwanted(orderId, session, placed.payment);
    if (placed.headerStatus === PaymentOrderStatus.OPEN) throw new ConcurrentSessionOpenError(orderId);
    return CLOSED('conflict');
  }

  /** Null when the old session is provably dead and should be retired; throws when that is unknown. */
  private async reuse(active: Payment): Promise<Opened | null> {
    const probe = await this.gateway.retrieveSession(active.providerSessionId);
    switch (probe.status) {
      // PAID too: a completed manual session may report either while the hold is being recorded.
      case 'PENDING':
      case 'PAID':
        return opened(active, probe);
      case 'FAILED':
        return null;
      case 'UNKNOWN':
        throw new PaymentGatewayError(`cannot tell whether session ${active.providerSessionId} still takes money`);
    }
  }

  private async closeUnwanted(orderId: string, session: GatewaySession, payment: Payment | null): Promise<void> {
    try {
      const outcome = await this.gateway.expireSession(session.providerSessionId);
      if (payment !== null && outcome !== 'already_completed') {
        await this.payments.updateStatus(payment.id as string, PaymentStatus.EXPIRED, {
          expectedStatus: PaymentStatus.PENDING,
        });
      }
    } catch (error) {
      // A recorded row stays PENDING for the cancel sweep and reconcile to close.
      this.logger.error(
        { orderId, providerSessionId: session.providerSessionId, recorded: payment !== null, err: toError(error) },
        'session opened under a closed header could not be expired',
      );
    }
  }
}

function opened(payment: Payment, session: { redirectUrl?: string; clientSecret?: string }): Opened {
  return {
    outcome: 'OPENED',
    paymentId: payment.id as string,
    providerSessionId: payment.providerSessionId,
    redirectUrl: session.redirectUrl,
    clientSecret: session.clientSecret,
  };
}
