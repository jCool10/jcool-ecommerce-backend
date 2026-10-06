import { ReservationOrderStatus } from './reservation-order-status';

export type FenceOp = 'try' | 'commit' | 'release' | 'restock';

const { HELD, COMMITTED, RELEASED, FENCED, RESTOCKED } = ReservationOrderStatus;

export interface SettledBy {
  try: typeof HELD;
  commit: typeof COMMITTED;
  release: typeof RELEASED | typeof FENCED;
  restock: typeof RESTOCKED;
}

export type FenceDecision<Op extends FenceOp> =
  { kind: 'apply'; to: SettledBy[Op] } | { kind: 'idempotent'; status: SettledBy[Op] } | { kind: 'conflict' };

// `null` is an order with no header row yet.
const TRANSITIONS: { [Op in FenceOp]: ReadonlyArray<readonly [ReservationOrderStatus | null, SettledBy[Op]]> } = {
  try: [[null, HELD]],
  commit: [[HELD, COMMITTED]],
  release: [
    [null, FENCED],
    [HELD, RELEASED],
  ],
  restock: [[COMMITTED, RESTOCKED]],
};

const SETTLED: { [Op in FenceOp]: ReadonlyArray<SettledBy[Op]> } = {
  try: [HELD],
  commit: [COMMITTED],
  release: [RELEASED, FENCED],
  restock: [RESTOCKED],
};

// Anything not listed is a conflict, e.g. a hanging Try reaching a RELEASED or FENCED order.
export function fenceDecision<Op extends FenceOp>(op: Op, current: ReservationOrderStatus | null): FenceDecision<Op> {
  const transitions: ReadonlyArray<readonly [ReservationOrderStatus | null, SettledBy[Op]]> = TRANSITIONS[op];
  const transition = transitions.find(([from]) => from === current);
  if (transition) {
    return { kind: 'apply', to: transition[1] };
  }
  const settled: ReadonlyArray<SettledBy[Op]> = SETTLED[op];
  const status = settled.find((candidate) => candidate === current);
  if (status) {
    return { kind: 'idempotent', status };
  }
  return { kind: 'conflict' };
}
