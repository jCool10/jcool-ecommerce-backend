import { BadGatewayException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { OrderStatus } from '../../domain/order-status';
import { CHECKOUT_SAGA_REPOSITORY, type CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import {
  PAYMENT_TCC,
  PaymentUnavailableError,
  type OpenSessionAnswer,
  type PaymentSession,
  type PaymentTccPort,
} from '../ports/payment-participant.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../saga/checkout-saga.settings';

const LOG_CONTEXT = 'PayOrder';

/**
 * Opens a payment session for a PENDING order and nothing more; the saga moves on the authorization.
 * The amount is always the order's own total, never anything the client sent.
 */
@Injectable()
export class PayOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    @Inject(PAYMENT_TCC) private readonly payment: PaymentTccPort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string, userId: string): Promise<PaymentSession> {
    // Absent, someone else's, or not yet visible to the buyer: all 404, never leaking the id.
    const order = await this.orders.findForUser(orderId, userId);
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(`Order is not payable in status ${order.status}`);
    }
    const saga = await this.sagas.findByOrderId(orderId);
    if (!saga) throw new Error(`Pending order ${orderId} has no checkout saga`);
    // A session opened past the cutoff could not stay open long enough for the buyer to finish.
    if (Date.now() >= saga.deadlineAt.getTime() - this.settings.payCutoffMs) {
      throw new ConflictException('Payment window closed');
    }

    let answer: OpenSessionAnswer;
    try {
      answer = await this.payment.openSession({
        orderId,
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        expiresAt: saga.deadlineAt,
      });
    } catch (error) {
      this.metrics.recordSagaStep('open_session', 'failed');
      if (error instanceof PaymentUnavailableError) {
        this.logger.error({ orderId, err: error }, 'payment provider unavailable while opening a session');
        throw new BadGatewayException('Payment provider is temporarily unavailable', { cause: error });
      }
      throw error;
    }

    if (answer.outcome === 'CLOSED') {
      this.metrics.recordSagaStep('open_session', 'failed');
      throw new ConflictException('Payment window closed');
    }
    this.metrics.recordSagaStep('open_session', 'success');
    this.logger.info({ orderId, paymentId: answer.session.paymentId }, 'payment session opened');
    return answer.session;
  }
}
