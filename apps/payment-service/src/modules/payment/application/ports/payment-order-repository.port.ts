import type { DrizzleTx } from '../../../../database';
import type { PaymentOrderStatus } from '../../domain/payment-order-status';
import type { PaymentParticipantStatus } from '../public/payment-participant.port';

export const PAYMENT_ORDER_REPOSITORY = Symbol('PAYMENT_ORDER_REPOSITORY');

export interface PaymentOrderHeader {
  orderId: string;
  status: PaymentOrderStatus;
  amountMinor: number | null;
  currency: string | null;
  authorizedAt: Date | null;
}

/** The header is always locked before any of the order's `payments` rows. */
export interface PaymentOrderRepositoryPort {
  /** ON CONFLICT DO NOTHING: false when the order already has a header. */
  insertOpen(tx: DrizzleTx, header: { orderId: string; amountMinor: number; currency: string }): Promise<boolean>;

  insertFenced(tx: DrizzleTx, orderId: string): Promise<boolean>;

  findForUpdate(tx: DrizzleTx, orderId: string): Promise<PaymentOrderHeader | null>;

  /** Unlocked: for deciding before a Stripe call, never for writing. */
  find(orderId: string): Promise<PaymentOrderHeader | null>;

  update(tx: DrizzleTx, orderId: string, patch: { status?: PaymentOrderStatus; authorizedAt?: Date }): Promise<void>;

  /** One statement on the pool, no transaction, no lock. */
  findParticipantStatuses(orderIds: string[]): Promise<Map<string, PaymentParticipantStatus>>;
}
