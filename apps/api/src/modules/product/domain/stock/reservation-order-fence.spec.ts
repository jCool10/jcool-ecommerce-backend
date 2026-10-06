import { describe, expect, it } from 'vitest';
import { fenceDecision, type FenceOp } from './reservation-order-fence';
import { RESERVATION_ORDER_STATUSES, type ReservationOrderStatus } from './reservation-order-status';

const apply = (to: ReservationOrderStatus) => ({ kind: 'apply', to });
const idempotent = (status: ReservationOrderStatus) => ({ kind: 'idempotent', status });
const conflict = { kind: 'conflict' };

const OPS: readonly FenceOp[] = ['try', 'commit', 'release', 'restock'];

const TABLE: Array<[ReservationOrderStatus | null, Record<FenceOp, object>]> = [
  [null, { try: apply('HELD'), commit: conflict, release: apply('FENCED'), restock: conflict }],
  ['HELD', { try: idempotent('HELD'), commit: apply('COMMITTED'), release: apply('RELEASED'), restock: conflict }],
  ['COMMITTED', { try: conflict, commit: idempotent('COMMITTED'), release: conflict, restock: apply('RESTOCKED') }],
  ['RELEASED', { try: conflict, commit: conflict, release: idempotent('RELEASED'), restock: conflict }],
  ['FENCED', { try: conflict, commit: conflict, release: idempotent('FENCED'), restock: conflict }],
  ['RESTOCKED', { try: conflict, commit: conflict, release: conflict, restock: idempotent('RESTOCKED') }],
];

const CASES = TABLE.flatMap(([status, row]) => OPS.map((op) => [op, status, row[op]] as const));

describe('fenceDecision', () => {
  it.each(CASES)('%s on %s', (op, status, expected) => {
    expect(fenceDecision(op, status)).toEqual(expected);
  });

  it('covers every status the header can hold', () => {
    expect(TABLE.map(([status]) => status)).toEqual([null, ...RESERVATION_ORDER_STATUSES]);
  });
});
