import { ReservationOrderStatus } from './reservation-order-status';

export type ReservationFenceOp = 'try' | 'commit' | 'release' | 'restock';

export type ReservationFenceDecision =
  { kind: 'apply'; next: ReservationOrderStatus } | { kind: 'idempotent' } | { kind: 'conflict' };

const IDEMPOTENT: ReservationFenceDecision = { kind: 'idempotent' };
const CONFLICT: ReservationFenceDecision = { kind: 'conflict' };

const apply = (next: ReservationOrderStatus): ReservationFenceDecision => ({ kind: 'apply', next });

/**
 * What a TCC command may do given the order's header (`null` = no header yet). Release on a missing
 * header is the empty rollback: it writes FENCED, and a Try arriving after that is refused (hanging).
 */
export function decideReservationFence(
  op: ReservationFenceOp,
  current: ReservationOrderStatus | null,
): ReservationFenceDecision {
  switch (op) {
    case 'try':
      if (current === null) return apply(ReservationOrderStatus.HELD);
      return current === ReservationOrderStatus.HELD ? IDEMPOTENT : CONFLICT;
    case 'commit':
      if (current === ReservationOrderStatus.HELD) return apply(ReservationOrderStatus.COMMITTED);
      return current === ReservationOrderStatus.COMMITTED ? IDEMPOTENT : CONFLICT;
    case 'release':
      if (current === null) return apply(ReservationOrderStatus.FENCED);
      if (current === ReservationOrderStatus.HELD) return apply(ReservationOrderStatus.RELEASED);
      return current === ReservationOrderStatus.RELEASED || current === ReservationOrderStatus.FENCED
        ? IDEMPOTENT
        : CONFLICT;
    case 'restock':
      if (current === ReservationOrderStatus.COMMITTED) return apply(ReservationOrderStatus.RESTOCKED);
      return current === ReservationOrderStatus.RESTOCKED ? IDEMPOTENT : CONFLICT;
  }
}
