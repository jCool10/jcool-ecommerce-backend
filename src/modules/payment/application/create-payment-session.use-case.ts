import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import { ORDER_READ_PORT, type OrderReadPort } from './ports/order-read.port';
import {
  DuplicateActivePaymentError,
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from './ports/payment-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './ports/payment-gateway.port';

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
 * Start a payment for a PENDING order: authorize the caller owns it, snapshot the order total,
 * ask the gateway for a session, and persist a PENDING Payment. The order is NOT finalized here
 * (that is a later week's webhook/reconcile work) — this only opens the payment.
 */
@Injectable()
export class CreatePaymentSessionUseCase {
  constructor(
    @Inject(ORDER_READ_PORT) private readonly orders: OrderReadPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
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
    // idempotencyKey is a seam: the network-free adapter ignores it today. A live SDK must key per
    // attempt (not per order) — else a retry after a FAILED payment replays the stale failed session
    // instead of opening a fresh one.
    const session = await this.gateway.createSession({
      orderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      idempotencyKey: orderId,
    });

    const payment = Payment.create({
      orderId,
      provider: this.gateway.provider,
      providerSessionId: session.providerSessionId,
      amountMinor: order.amountMinor,
      currency: order.currency,
    });

    let saved: Payment;
    try {
      saved = await this.payments.create(payment);
    } catch (error) {
      // A concurrent request beat us past the pre-check and won the DB unique index — same outcome.
      if (error instanceof DuplicateActivePaymentError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    return {
      paymentId: saved.id as string,
      providerSessionId: saved.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }
}
