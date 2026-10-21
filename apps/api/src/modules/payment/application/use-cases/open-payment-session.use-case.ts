import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '@shared/identity/id-generator.port';
import { decidePaymentOrderOp } from '../../domain/payment-order-fence';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import { Payment } from '../../domain/payment.entity';
import { PAYMENT_GATEWAY, type GatewaySession, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import {
  DuplicateActivePaymentError,
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import type { OpenSessionInput, OpenSessionResult } from '../public/payment-participant.port';
import { heldCharge, RecordAuthorizationUseCase } from './record-authorization.use-case';

const LOG_CONTEXT = 'OpenPaymentSession';
const CLOSED: OpenSessionResult = { outcome: 'CLOSED' };

type Probe = { result: OpenSessionResult } | { retiring: Payment | null };

/**
 * Opens a manual-capture session under the order's header, act-then-check: tx1 claims the header,
 * Stripe is called with no transaction open, and tx2 inserts the payment only if the header is still
 * OPEN and nothing else became active. A cancel that slips in between always wins.
 */
@Injectable()
export class OpenPaymentSessionUseCase {
  private readonly minLeadMs: number;

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly recordAuthorization: RecordAuthorizationUseCase,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    const minTtlSec = requireIntConfig(config, 'payment.sessionMinTtlSec', 0);
    const marginSec = requireIntConfig(config, 'payment.sessionExpiryMarginSec', 0);
    this.minLeadMs = (minTtlSec + marginSec) * 1_000;
    logger.setContext(LOG_CONTEXT);
  }

  async execute(input: OpenSessionInput): Promise<OpenSessionResult> {
    const { orderId, expiresAt } = input;
    // Stripe refuses an `expires_at` this close, so there is no session to offer.
    if (expiresAt.getTime() < Date.now() + this.minLeadMs) return CLOSED;

    const amountMinor = input.amountMinor;
    const currency = input.currency.toUpperCase();
    const current = await this.transactionRunner.run(async (tx) => {
      await this.headers.insertOpen(tx, { orderId, amountMinor, currency });
      const header = await this.headers.findForUpdate(tx, orderId);
      if (!header || decidePaymentOrderOp('open_session', header.status) === 'closed') return null;
      if (header.amountMinor !== amountMinor || header.currency?.toUpperCase() !== currency) {
        this.logger.error(
          {
            orderId,
            locked: { amountMinor: header.amountMinor, currency: header.currency },
            asked: { amountMinor, currency },
          },
          'open refused: charge differs from the one the header locked in',
        );
        return null;
      }
      return { active: await this.payments.findActiveByOrderIdForUpdate(tx, orderId) };
    });
    if (!current) return CLOSED;

    const probe = await this.probe(current.active);
    if ('result' in probe) return probe.result;

    const paymentId = await mintOne(this.idGenerator);
    const session = await this.gateway.createSession({
      orderId,
      amountMinor,
      currency,
      idempotencyKey: uuidv7(),
      captureMethod: 'manual',
      expiresAt,
    });

    const created = await this.insertIfStillOpen(input, currency, session, paymentId, probe.retiring);
    if (!created) {
      // The URL never left this service, so a session we cannot close is unreachable anyway.
      await this.gateway.expireSession(session.providerSessionId).catch((error: unknown) => {
        this.logger.error({ orderId, err: toError(error) }, 'could not close a session the order no longer wants');
      });
      return CLOSED;
    }
    return {
      outcome: 'OPENED',
      paymentId,
      providerSessionId: session.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }

  // The current attempt decides whether a new session may open: reuse it while Stripe still offers
  // it, replace it only once Stripe confirms it expired, otherwise open nothing.
  private async probe(active: Payment | null): Promise<Probe> {
    if (!active) return { retiring: null };
    if (active.status !== PaymentStatus.PENDING) return { result: CLOSED };

    const authorization = await this.gateway.retrieveAuthorization(active.providerSessionId);
    switch (authorization.sessionStatus) {
      case 'open':
        return {
          result: {
            outcome: 'OPENED',
            paymentId: active.id as string,
            providerSessionId: active.providerSessionId,
            redirectUrl: authorization.redirectUrl,
          },
        };
      case 'expired':
        return { retiring: active };
      case 'complete': {
        const hold = heldCharge(authorization);
        if (hold) await this.recordAuthorization.record(active, hold, new Date());
        return { result: CLOSED };
      }
      case 'unknown':
        return { result: CLOSED };
    }
  }

  private async insertIfStillOpen(
    input: OpenSessionInput,
    currency: string,
    session: GatewaySession,
    paymentId: string,
    retiring: Payment | null,
  ): Promise<Payment | null> {
    try {
      return await this.transactionRunner.run(async (tx) => {
        const header = await this.headers.findForUpdate(tx, input.orderId);
        if (header?.status !== PaymentOrderStatus.OPEN) return null;

        const active = await this.payments.findActiveByOrderIdForUpdate(tx, input.orderId);
        if (active && active.id !== retiring?.id) return null;
        if (active) {
          const retired = await this.payments.updateStatus(active.id as string, PaymentStatus.EXPIRED, {
            expectedStatus: PaymentStatus.PENDING,
            tx,
          });
          if (!retired) return null;
        }

        const payment = Payment.create({
          orderId: input.orderId,
          provider: this.gateway.provider,
          providerSessionId: session.providerSessionId,
          amountMinor: input.amountMinor,
          currency,
        });
        return this.payments.create(payment, tx, paymentId);
      });
    } catch (error) {
      // A payment opened by the legacy /pay path, which never takes the header lock.
      if (error instanceof DuplicateActivePaymentError) return null;
      throw error;
    }
  }
}
