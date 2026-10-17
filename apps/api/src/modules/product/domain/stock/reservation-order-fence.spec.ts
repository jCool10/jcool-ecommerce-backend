import { describe, expect, it } from 'vitest';
import { fenceDecision, type FenceOp } from './reservation-order-fence';
import { RESERVATION_ORDER_STATUSES, type ReservationOrderStatus } from './reservation-order-status';

type Cell = 'conflict' | `apply ${ReservationOrderStatus}` | `idempotent ${ReservationOrderStatus}`;

const TABLE: Record<FenceOp, Record<ReservationOrderStatus | 'NONE', Cell>> = {
  try: {
    NONE: 'apply HELD',
    HELD: 'idempotent HELD',
    COMMITTED: 'conflict',
    RELEASED: 'conflict',
    FENCED: 'conflict',
    RESTOCKED: 'conflict',
  },
  commit: {
    NONE: 'conflict',
    HELD: 'apply COMMITTED',
    COMMITTED: 'idempotent COMMITTED',
    RELEASED: 'conflict',
    FENCED: 'conflict',
    RESTOCKED: 'conflict',
  },
  release: {
    NONE: 'apply FENCED',
    HELD: 'apply RELEASED',
    COMMITTED: 'conflict',
    RELEASED: 'idempotent RELEASED',
    FENCED: 'idempotent FENCED',
    RESTOCKED: 'conflict',
  },
  restock: {
    NONE: 'conflict',
    HELD: 'conflict',
    COMMITTED: 'apply RESTOCKED',
    RELEASED: 'conflict',
    FENCED: 'conflict',
    RESTOCKED: 'idempotent RESTOCKED',
  },
};

const cases = (Object.keys(TABLE) as FenceOp[]).flatMap((op) =>
  ([null, ...RESERVATION_ORDER_STATUSES] as const).map((status) => ({
    op,
    status,
    expected: TABLE[op][status ?? 'NONE'],
  })),
);

describe('fenceDecision', () => {
  it('covers every op against every header state', () => {
    expect(cases).toHaveLength(24);
  });

  it.each(cases)('$op on $status → $expected', ({ op, status, expected }) => {
    const decision = fenceDecision(op, status);

    const cell = decision.kind === 'conflict' ? 'conflict' : `${decision.kind} ${decision.status}`;
    expect(cell).toBe(expected);
  });
});
