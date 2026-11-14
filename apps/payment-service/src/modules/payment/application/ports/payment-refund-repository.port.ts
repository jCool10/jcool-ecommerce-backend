import type { DrizzleTx } from '../../../../database';
import type { PaymentRefundStatus } from '../../domain/payment-refund-status';

export const PAYMENT_REFUND_REPOSITORY = Symbol('PAYMENT_REFUND_REPOSITORY');

export interface PaymentRefund {
  id: string;
  orderId: string;
  paymentId: string;
  providerRefundId: string | null;
  /** The refunds made elsewhere that together cover the charge; empty when `providerRefundId` names one. */
  coveredRefundIds: string[];
  requestedBy: string;
  amountMinor: number;
  currency: string;
  status: PaymentRefundStatus;
  failureReason: string | null;
}

export type NewPaymentRefund = Pick<
  PaymentRefund,
  'id' | 'orderId' | 'paymentId' | 'requestedBy' | 'amountMinor' | 'currency'
>;

export interface PaymentRefundPatch {
  status: PaymentRefundStatus;
  providerRefundId?: string;
  coveredRefundIds?: string[];
  failureReason: string | null;
}

/** One row per order. Lock the order's header before reading or writing it. */
export interface PaymentRefundRepositoryPort {
  /** PENDING. ON CONFLICT on the order DO NOTHING: false when the order already has its refund row. */
  insert(tx: DrizzleTx, refund: NewPaymentRefund): Promise<boolean>;

  findByOrderId(orderId: string, tx?: DrizzleTx): Promise<PaymentRefund | null>;

  findByProviderRefundId(providerRefundId: string, tx?: DrizzleTx): Promise<PaymentRefund | null>;

  /** Compare-and-set on `expectedStatus`; false when the row moved meanwhile. */
  update(tx: DrizzleTx, id: string, patch: PaymentRefundPatch, expectedStatus: PaymentRefundStatus): Promise<boolean>;
}
