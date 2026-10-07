import { PaymentOrderStatus } from './payment-order-status';

const { OPEN, AUTHORIZED, CAPTURED } = PaymentOrderStatus;

// `null` is an order with no header row yet.
type HeaderStatus = PaymentOrderStatus | null;

/** `create` inserts the header; `open` reuses or opens an attempt under it. */
export type OpenSessionAction = 'create' | 'open' | 'closed';

export type CaptureAction = 'capture' | 'captured' | 'not_capturable';

/** `fence` inserts a header with no amount; `sweep` re-closes what may still be open under a shut one. */
export type CancelAction = 'fence' | 'cancel' | 'sweep' | 'captured_conflict';

export function openSessionAction(status: HeaderStatus): OpenSessionAction {
  if (status === null) return 'create';
  return status === OPEN ? 'open' : 'closed';
}

export function captureAction(status: HeaderStatus): CaptureAction {
  if (status === AUTHORIZED) return 'capture';
  return status === CAPTURED ? 'captured' : 'not_capturable';
}

export function cancelAction(status: HeaderStatus): CancelAction {
  switch (status) {
    case null:
      return 'fence';
    case OPEN:
    case AUTHORIZED:
      return 'cancel';
    case CAPTURED:
      return 'captured_conflict';
    default:
      return 'sweep';
  }
}

export function headerAfterAuthorization(status: PaymentOrderStatus): PaymentOrderStatus {
  return status === OPEN ? AUTHORIZED : status;
}
