import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { FinalizeOrderUseCase } from '@modules/order/application/use-cases';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { ORDER_READ_PORT, type OrderReadPort, type StalePendingOrderView } from '../ports/order-read.port';
import { PAYMENT_GATEWAY, type GatewayPaymentStatus, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { mapGatewayStatusToOutcome, type GatewayOutcome } from '../mappers/map-gateway-status-to-outcome';

const LOG_CONTEXT = 'ReconcileStaleOrders';

const PAYMENT_STATUS_FOR: Record<GatewayOutcome, PaymentStatus> = {
  PAID: PaymentStatus.SUCCEEDED,
  FAILED: PaymentStatus.FAILED,
  EXPIRED: PaymentStatus.EXPIRED,
};

export interface ReconcileInput {
  /** The guard against racing a webhook still in flight: younger orders are left alone. */
  staleAfterSec: number;
  /** Past this age an unsettled order expires, freeing its stock hold. */
  ttlSec: number;
  /** Caps gateway calls per tick; the rest wait for the next one. */
  batchSize: number;
}

type OrderOutcome = 'finalized' | 'stillPending' | 'alreadySettled' | 'raced' | 'unresolved';

export interface ReconcileSummary {
  scanned: number;
  finalized: number;
  /** Undecided at the gateway and not yet past TTL — left for the webhook. */
  stillPending: number;
  /** A webhook had already settled these the same way; the sweep confirmed and changed nothing. */
  alreadySettled: number;
  /** A webhook settled the payment mid-sweep. Benign, but a high rate means the sweep polls too eagerly. */
  raced: number;
  /** The gateway's answer could not be applied — a money/status mismatch needing a human. */
  unresolved: number;
  /** Threw (gateway unreachable, DB fault); the next sweep retries them. */
  errors: number;
}

/**
 * The second source of truth behind the webhook, so a lost delivery still converges; also the expiry
 * sweep — past its TTL an unsettled order is expired to release its stock hold. Loop invariants:
 * gateway I/O outside every transaction, one try/catch per order, payment settled before order, and
 * compare-and-set on every payment write.
 */
@Injectable()
export class ReconcileStaleOrdersUseCase {
  constructor(
    @Inject(ORDER_READ_PORT) private readonly orders: OrderReadPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly finalizeOrder: FinalizeOrderUseCase,
    private readonly logger: PinoLogger,
  ) {}

  async execute({ staleAfterSec, ttlSec, batchSize }: ReconcileInput): Promise<ReconcileSummary> {
    const now = Date.now();
    const stale = await this.orders.findStalePending({
      placedBefore: new Date(now - staleAfterSec * 1000),
      limit: batchSize,
    });

    const summary: ReconcileSummary = {
      scanned: stale.length,
      finalized: 0,
      stillPending: 0,
      alreadySettled: 0,
      raced: 0,
      unresolved: 0,
      errors: 0,
    };
    const expiredBefore = new Date(now - ttlSec * 1000);
    // Past this age a failure is no longer transient, and the stock hold will not free itself.
    const stuckBefore = new Date(now - 2 * ttlSec * 1000);

    for (const order of stale) {
      try {
        summary[await this.settleOne(order, expiredBefore)] += 1;
      } catch (error) {
        summary.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (order.placedAt < stuckBefore) {
          // Deliberately not expired blind: guessing would charge a buyer for a deleted order.
          this.logger.error(
            { context: LOG_CONTEXT, orderId: order.id, stuck: true },
            `reconcile still cannot settle an order long past its TTL — stock stays held: ${message}`,
          );
        } else {
          this.logger.warn({ context: LOG_CONTEXT, orderId: order.id }, `reconcile failed for order: ${message}`);
        }
      }
    }

    return summary;
  }

  private async settleOne(order: StalePendingOrderView, expiredBefore: Date): Promise<OrderOutcome> {
    const payment = await this.payments.findByOrderId(order.id);
    // No payment row = a session was never opened, so there is nothing to ask; only the TTL applies.
    const probe: GatewayPaymentStatus = payment
      ? await this.gateway.getPaymentStatus(payment.providerSessionId)
      : { status: 'UNKNOWN' };

    const outcome = mapGatewayStatusToOutcome(probe.status, { pastTtl: order.placedAt < expiredBefore });
    if (outcome === null) {
      return 'stillPending';
    }

    if (outcome === 'EXPIRED' && payment) {
      if (probe.status === 'UNKNOWN') {
        // One unrecognised handle is a data fault; a burst of them is a key pointing at the wrong
        // account, which would otherwise expire every pending order in silence.
        this.logger.warn(
          { context: LOG_CONTEXT, orderId: order.id },
          'gateway does not recognise the session handle — expiring on TTL alone',
        );
      }
      // The page must stop taking money BEFORE the stock hold is released, or a buyer returning to it
      // pays for an order that no longer exists. A refusal for any reason but a completed session
      // throws, leaving the order for the next tick.
      const closed = await this.gateway.expireSession(payment.providerSessionId);
      if (closed === 'already_completed') {
        // The buyer paid between the probe above and this call. Expiring now would settle the order
        // unpaid on top of money that moved; the next tick probes again and reads PAID.
        this.logger.info(
          { context: LOG_CONTEXT, orderId: order.id, paymentId: payment.id },
          'checkout session was paid mid-sweep — leaving the order for the next tick',
        );
        return 'raced';
      }
    }

    if (payment && payment.id !== null) {
      if (payment.status === PaymentStatus.PENDING) {
        const settled = settlePayment(payment, outcome);
        const written = await this.payments.updateStatus(payment.id, settled.status, {
          expectedStatus: PaymentStatus.PENDING,
          // Fills a gap only — a handle already on the row came from the webhook and stays.
          ...(payment.providerIntentId === null && probe.intentId ? { providerIntentId: probe.intentId } : {}),
        });
        if (written === null) {
          // A webhook settled it inside our round-trip, so it owns the finalize. Back off.
          this.logger.info(
            { context: LOG_CONTEXT, orderId: order.id, paymentId: payment.id },
            'payment was settled by a webhook mid-sweep — leaving the order to it',
          );
          return 'raced';
        }
      } else if (payment.status !== PAYMENT_STATUS_FOR[outcome]) {
        // Reachable when an earlier sweep crashed between its two writes. The order still finalizes,
        // but the money row now records a different ending than the gateway does.
        this.logger.warn(
          { context: LOG_CONTEXT, orderId: order.id, paymentStatus: payment.status, gatewayStatus: probe.status },
          'payment is already terminal in a state the gateway disagrees with',
        );
      }
    }

    const finalize = await this.finalizeOrder.execute({
      orderId: order.id,
      outcome,
      paymentRef: payment?.providerIntentId ?? probe.intentId ?? null,
      reason: `reconcile:${outcome.toLowerCase()}`,
    });

    if (finalize.status === 'ignored' || finalize.status === 'not_found') {
      // Money side and order side disagree, and no retry fixes that — surface it for a human.
      this.logger.warn(
        { context: LOG_CONTEXT, orderId: order.id, gatewayStatus: probe.status, outcome, finalize: finalize.status },
        'reconcile could not apply the gateway outcome to the order',
      );
      return 'unresolved';
    }

    return finalize.status === 'finalized' ? 'finalized' : 'alreadySettled';
  }
}

function settlePayment(payment: Payment, outcome: GatewayOutcome): Payment {
  switch (PAYMENT_STATUS_FOR[outcome]) {
    case PaymentStatus.SUCCEEDED:
      return payment.markSucceeded();
    case PaymentStatus.FAILED:
      return payment.markFailed();
    default:
      return payment.markExpired();
  }
}
