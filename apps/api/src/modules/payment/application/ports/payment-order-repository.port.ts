import type { DrizzleTx } from '@shared/infrastructure/database';
import type { PaymentOrderStatus } from '../../domain/payment-order-status';

export const PAYMENT_ORDER_REPOSITORY = Symbol('PAYMENT_ORDER_REPOSITORY');

/** Amount and currency are null only on a FENCED header, which cancel inserted before any open. */
export interface PaymentOrderHeader {
  orderId: string;
  status: PaymentOrderStatus;
  amountMinor: number | null;
  currency: string | null;
}

/** Every write takes the caller's tx: the header is locked before any of the order's payments. */
export interface PaymentOrderRepositoryPort {
  /** ON CONFLICT DO NOTHING; false when another caller's header already stands. */
  insertIfAbsent(tx: DrizzleTx, header: PaymentOrderHeader): Promise<boolean>;

  findForUpdate(tx: DrizzleTx, orderId: string): Promise<PaymentOrderHeader | null>;

  /** Unlocked, for deciding before a tx whether a payment runs under the fence at all. */
  find(orderId: string): Promise<PaymentOrderHeader | null>;

  /** Compare-and-set on `expected`; false when the header already moved. */
  updateStatus(
    tx: DrizzleTx,
    orderId: string,
    status: PaymentOrderStatus,
    expected: PaymentOrderStatus,
  ): Promise<boolean>;
}
