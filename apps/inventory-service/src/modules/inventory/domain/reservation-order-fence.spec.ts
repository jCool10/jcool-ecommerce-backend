import { describe, expect, it } from 'vitest';
import {
  decideReservationFence,
  type ReservationFenceDecision,
  type ReservationFenceOp,
} from './reservation-order-fence';
import { RESERVATION_ORDER_STATUSES, type ReservationOrderStatus } from './reservation-order-status';

const apply = (next: ReservationOrderStatus): ReservationFenceDecision => ({ kind: 'apply', next });
const IDEMPOTENT: ReservationFenceDecision = { kind: 'idempotent' };
const CONFLICT: ReservationFenceDecision = { kind: 'conflict' };

type Row = Record<ReservationFenceOp, ReservationFenceDecision>;

const TABLE: Record<ReservationOrderStatus | 'none', Row> = {
  none: { try: apply('HELD'), commit: CONFLICT, release: apply('FENCED'), restock: CONFLICT },
  HELD: { try: IDEMPOTENT, commit: apply('COMMITTED'), release: apply('RELEASED'), restock: CONFLICT },
  COMMITTED: { try: CONFLICT, commit: IDEMPOTENT, release: CONFLICT, restock: apply('RESTOCKED') },
  RELEASED: { try: CONFLICT, commit: CONFLICT, release: IDEMPOTENT, restock: CONFLICT },
  FENCED: { try: CONFLICT, commit: CONFLICT, release: IDEMPOTENT, restock: CONFLICT },
  RESTOCKED: { try: CONFLICT, commit: CONFLICT, release: CONFLICT, restock: IDEMPOTENT },
};

const CASES = (['none', ...RESERVATION_ORDER_STATUSES] as const).flatMap((status) =>
  (Object.keys(TABLE[status]) as ReservationFenceOp[]).map((op) => ({ status, op, expected: TABLE[status][op] })),
);

describe('decideReservationFence', () => {
  it('covers every operation against every header state', () => {
    expect(CASES).toHaveLength(24);
  });

  it.each(CASES)('$op on $status → $expected.kind', ({ status, op, expected }) => {
    expect(decideReservationFence(op, status === 'none' ? null : status)).toEqual(expected);
  });
});
