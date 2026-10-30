import { OrderStatus } from './order-status';

// What must hold between a settled checkout order and its two participants once compensation is
// over. The shapes mirror the participants' statusOf answers, so the checker passes them straight in.

export const CHECKOUT_INVARIANT_KINDS = [
  'captured_without_paid',
  'paid_without_capture',
  'paid_without_commit',
  'orphan_hold',
  'authorized_on_dead_order',
] as const;
export type CheckoutInvariantKind = (typeof CHECKOUT_INVARIANT_KINDS)[number];

export const TERMINAL_SAGA_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
] as const;
export type TerminalSagaStatus = (typeof TERMINAL_SAGA_STATUSES)[number];

/** Null when stock never heard of the order. */
export type StockStanding = 'HELD' | 'COMMITTED' | 'RELEASED' | 'FENCED' | 'RESTOCKED' | null;

export interface PaymentStanding {
  header: 'OPEN' | 'AUTHORIZED' | 'CAPTURED' | 'CANCELLED' | 'FENCED' | null;
  authorizedPaymentId: string | null;
  /** Any attempt still holding money, whatever the header says. */
  hasAuthorizedAttempt: boolean;
  hasSucceededAttempt: boolean;
}

export interface SettledCheckout {
  status: OrderStatus;
  stock: StockStanding;
  payment: PaymentStanding;
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(TERMINAL_SAGA_STATUSES);

export function evaluateCheckoutInvariants({ status, stock, payment }: SettledCheckout): CheckoutInvariantKind[] {
  if (!TERMINAL.has(status)) throw new Error(`Checkout invariants apply to settled orders, not ${status}`);
  const paid = status === OrderStatus.PAID;
  const broken: CheckoutInvariantKind[] = [];

  if (!paid && (payment.header === 'CAPTURED' || payment.hasSucceededAttempt)) broken.push('captured_without_paid');
  if (paid && payment.header !== 'CAPTURED') broken.push('paid_without_capture');
  if (paid && stock !== 'COMMITTED') broken.push('paid_without_commit');
  if (!paid && stock === 'HELD') broken.push('orphan_hold');
  if (!paid && payment.hasAuthorizedAttempt) broken.push('authorized_on_dead_order');
  return broken;
}
