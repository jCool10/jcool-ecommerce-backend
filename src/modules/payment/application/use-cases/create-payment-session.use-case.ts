import { BadGatewayException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { toError } from '@shared/kernel/to-error';
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

const LOG_CONTEXT = 'CreatePaymentSession';

export interface CreatePaymentSessionResult {
  paymentId: string;
  providerSessionId: string;
  redirectUrl?: string;
  clientSecret?: string;
}

/** Opens a payment and nothing more: the order is settled by the webhook or the reconciliation sweep. */
@Injectable()
export class CreatePaymentSessionUseCase {
  constructor(
    @Inject(ORDER_READ_PORT) private readonly orders: OrderReadPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

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
    // idempotencyKey is minted per attempt, not per order: Stripe's own network retries stay safe,
    // while a retry after a FAILED payment still opens a FRESH session. No-double-charge does not rest
    // on this key — the DB active-payment guard and its unique index do.
    let session: GatewaySession;
    try {
      session = await this.gateway.createSession({
        orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        idempotencyKey: uuidv7(),
      });
    } catch (error) {
      // Provider/network fault — a 502, not a 500, and nothing is persisted yet. The client only sees
      // a masked generic 502, so log the gateway detail and chain the cause HERE or a checkout outage
      // is undiagnosable. A failed saga step, because the order is left with its stock still held.
      this.metrics.recordSagaStep('payment_session', 'failed');
      if (error instanceof PaymentGatewayError) {
        // `err` carries the gateway error AND its `cause` chain, which is where the provider's own
        // status and body live — the part a checkout outage is actually diagnosed from.
        this.logger.error({ orderId, err: error }, 'gateway createSession failed');
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
      // A concurrent request beat us past the pre-check and won the DB unique index. Not a failed step
      // — the order has an active payment, just not this request's — though the session this attempt
      // opened is orphaned at the gateway until it expires there.
      if (error instanceof DuplicateActivePaymentError) {
        throw new ConflictException(error.message);
      }
      // A session is now open at the gateway that no payment row points at: the order cannot be paid,
      // and nothing cleans the session up until the expiry sweep does.
      this.metrics.recordSagaStep('payment_session', 'failed');
      throw error;
    }

    await this.abortIfOrderDiedMeanwhile(orderId, saved);

    this.metrics.recordSagaStep('payment_session', 'success');
    return {
      paymentId: saved.id as string,
      providerSessionId: saved.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }

  /**
   * Re-reading the order AFTER the payment row commits makes the PENDING check an act-then-check that
   * needs no lock: a cancel commits either before this read (and this closes the session it just
   * opened) or after the payment row (and the `order.cancelled` consumer closes it). Without it, a
   * cancel inside the gateway round-trip finds no payment, acks, and leaves a payable session behind.
   */
  private async abortIfOrderDiedMeanwhile(orderId: string, payment: Payment): Promise<void> {
    const current = await this.orders.findForPayment(orderId);
    if (current !== null && current.status === ORDER_STATUS_PENDING) return;

    const status = current?.status ?? 'DELETED';
    try {
      await this.gateway.expireSession(payment.providerSessionId);
    } catch (error) {
      // Left PENDING deliberately — marking it EXPIRED would claim a session was closed that is
      // still live. Nothing retries this, so the gateway's own expiry is the backstop.
      this.logger.error(
        { orderId, status, err: toError(error) },
        'order settled while its checkout session was being opened, and the session could not be closed',
      );
      throw new ConflictException(`Order is not payable in status ${status}`);
    }

    await this.payments.updateStatus(payment.id as string, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    throw new ConflictException(`Order is not payable in status ${status}`);
  }
}
