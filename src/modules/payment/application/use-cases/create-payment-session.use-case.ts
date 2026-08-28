import { BadGatewayException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { ORDER_READ_PORT, type OrderReadPort } from '../ports/order-read.port';
import {
  DuplicateActivePaymentError,
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../ports/payment-repository.port';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type GatewaySession,
  type PaymentGatewayPort,
} from '../ports/payment-gateway.port';

// The order status that may start a payment. Compared as a string literal on purpose: Payment must
// not import Order's domain enum (cross-context boundary), and only needs to know this one value.
const ORDER_STATUS_PENDING = 'PENDING';

// A payment in one of these states already owns the order's charge; a second session would risk a
// double charge, so creating one is refused (409). FAILED/EXPIRED are terminal misses — a retry may
// open a fresh session.
const ACTIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED];

export interface CreatePaymentSessionResult {
  paymentId: string;
  providerSessionId: string;
  redirectUrl?: string;
  clientSecret?: string;
}

/**
 * Opens a payment for a PENDING order and nothing more: the order is settled elsewhere, by the
 * webhook or the reconciliation sweep.
 */
@Injectable()
export class CreatePaymentSessionUseCase {
  private readonly logger = new Logger(CreatePaymentSessionUseCase.name);

  constructor(
    @Inject(ORDER_READ_PORT) private readonly orders: OrderReadPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(orderId: string, userId: string): Promise<CreatePaymentSessionResult> {
    const order = await this.orders.findForPayment(orderId);
    // Absent OR owned by someone else both collapse to 404 — never leak another user's order id.
    if (!order || order.userId !== userId) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    if (order.status !== ORDER_STATUS_PENDING) {
      throw new ConflictException(`Order is not payable in status ${order.status}`);
    }

    const existing = await this.payments.findByOrderId(orderId);
    if (existing && ACTIVE_PAYMENT_STATUSES.includes(existing.status)) {
      throw new ConflictException(`Order already has an active payment (${existing.status})`);
    }

    // Amount is the order's frozen total, never a client-supplied figure (anti price-tampering).
    // idempotencyKey is minted per attempt (not per order): the live Stripe path keys its create
    // call so its own network retries are safe, while a retry after a FAILED payment still opens a
    // FRESH session instead of replaying the stale failed one. No-double-charge does not rest on this
    // key — the DB active-payment guard + unique index do; a lost race just leaves a harmless unpaid
    // session that Stripe expires. The offline adapter ignores the key.
    let session: GatewaySession;
    try {
      session = await this.gateway.createSession({
        orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        idempotencyKey: uuidv7(),
      });
    } catch (error) {
      // Provider/network fault (live Stripe down) — a 502, not a 500. Nothing persisted yet. The
      // client only ever sees a masked generic 502, so log the gateway detail + cause HERE or a
      // checkout outage is undiagnosable; chain the cause so Sentry links the original Stripe error.
      // The saga stalls here with stock still held, so it is a failed step — unlike the guards
      // above, which refuse a request without leaving the order any worse off.
      this.metrics.recordSagaStep('payment_session', 'failed');
      if (error instanceof PaymentGatewayError) {
        this.logger.error(
          `createSession failed for order ${orderId}: ${error.message}`,
          error.cause instanceof Error ? error.cause.stack : undefined,
        );
        throw new BadGatewayException('Payment provider is temporarily unavailable', { cause: error });
      }
      throw error;
    }

    let saved: Payment;
    try {
      // Built inside the try because the entity's own invariants can reject a malformed session, and
      // that strands one at the gateway exactly the way a failed insert does.
      saved = await this.payments.create(
        Payment.create({
          orderId,
          provider: this.gateway.provider,
          providerSessionId: session.providerSessionId,
          amountMinor: order.amountMinor,
          currency: order.currency,
        }),
      );
    } catch (error) {
      // A concurrent request beat us past the pre-check and won the DB unique index. Not a failed
      // step — the order has an active payment, just not this request's — though the session this
      // attempt opened is orphaned at the gateway until it expires there.
      if (error instanceof DuplicateActivePaymentError) {
        throw new ConflictException(error.message);
      }
      // A session now open at the gateway that no payment row points at: the order cannot be paid
      // and nothing will clean the session up until the expiry sweep does.
      this.metrics.recordSagaStep('payment_session', 'failed');
      throw error;
    }

    this.metrics.recordSagaStep('payment_session', 'success');
    return {
      paymentId: saved.id as string,
      providerSessionId: saved.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }
}
