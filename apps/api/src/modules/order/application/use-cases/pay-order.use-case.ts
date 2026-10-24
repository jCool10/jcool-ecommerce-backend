import { BadGatewayException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { OrderStatus } from '../../domain/order-status';
import {
  ORDER_PAYMENT_PARTICIPANT,
  PaymentProviderUnavailableError,
  type OrderPaymentParticipantPort,
} from '../ports/order-payment-participant.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const LOG_CONTEXT = 'PayOrder';

export interface PaymentSessionView {
  paymentId: string;
  providerSessionId: string;
  redirectUrl?: string;
  clientSecret?: string;
}

/**
 * Payment never reads the order, so every check lives here: owner, status, time left, and the charge,
 * which is the order's frozen total, never a client figure. The session dies at the payment deadline,
 * when the saga stops waiting for it.
 */
@Injectable()
export class PayOrderUseCase {
  private readonly payCutoffMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(ORDER_PAYMENT_PARTICIPANT) private readonly payment: OrderPaymentParticipantPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.payCutoffMs = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').payCutoffSec * 1000;
  }

  async execute(orderId: string, userId: string): Promise<PaymentSessionView> {
    const order = await this.orderRepo.findForUser(orderId, userId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(`Order is not payable in status ${order.status}`);
    }
    const deadline = order.paymentDeadlineAt;
    // Too little time left to pay before the saga expires the order.
    if (!deadline || deadline.getTime() - Date.now() < this.payCutoffMs) {
      throw new ConflictException('Payment window for this order has closed');
    }

    let session;
    try {
      session = await this.payment.openSession({
        orderId,
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        expiresAt: deadline,
      });
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) {
        this.logger.error({ orderId, err: error }, 'payment provider could not open a session');
        throw new BadGatewayException('Payment provider is temporarily unavailable', { cause: error });
      }
      throw error;
    }
    if (session.outcome === 'CLOSED') {
      throw new ConflictException('Order is no longer payable');
    }

    this.logger.info(
      { orderId, paymentId: session.paymentId, providerSessionId: session.providerSessionId },
      'payment session opened',
    );
    return {
      paymentId: session.paymentId,
      providerSessionId: session.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }
}
