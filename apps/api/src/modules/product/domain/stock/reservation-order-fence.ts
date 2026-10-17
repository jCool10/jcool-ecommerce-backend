import { ReservationOrderStatus } from './reservation-order-status';

export type FenceOp = 'try' | 'commit' | 'release' | 'restock';

/** The header status each op leaves behind when it succeeds. */
export interface FenceOutcome {
  try: 'HELD';
  commit: 'COMMITTED';
  release: 'RELEASED' | 'FENCED';
  restock: 'RESTOCKED';
}

export type FenceDecision<Op extends FenceOp> =
  { kind: 'apply' | 'idempotent'; status: FenceOutcome[Op] } | { kind: 'conflict' };

const { HELD, COMMITTED, RELEASED, FENCED, RESTOCKED } = ReservationOrderStatus;

type HeaderState = ReservationOrderStatus | 'NONE';

const TRANSITIONS: { [Op in FenceOp]: Partial<Record<HeaderState, FenceOutcome[Op]>> } = {
  try: { NONE: HELD },
  commit: { HELD: COMMITTED },
  release: { NONE: FENCED, HELD: RELEASED },
  restock: { COMMITTED: RESTOCKED },
};

const SETTLED: { [Op in FenceOp]: readonly FenceOutcome[Op][] } = {
  try: [HELD],
  commit: [COMMITTED],
  release: [RELEASED, FENCED],
  restock: [RESTOCKED],
};

/** `null` means the order has no header yet. Anything not listed above is a conflict. */
export function fenceDecision<Op extends FenceOp>(op: Op, current: ReservationOrderStatus | null): FenceDecision<Op> {
  const to = (TRANSITIONS[op] as Partial<Record<HeaderState, FenceOutcome[Op]>>)[current ?? 'NONE'];
  if (to) {
    return { kind: 'apply', status: to };
  }
  const settled = SETTLED[op] as readonly ReservationOrderStatus[];
  if (current && settled.includes(current)) {
    return { kind: 'idempotent', status: current as FenceOutcome[Op] };
  }
  return { kind: 'conflict' };
}
