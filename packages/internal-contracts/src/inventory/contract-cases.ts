import { isDeepStrictEqual } from 'node:util';
import {
  type CommandOutcome,
  LOCK_BUDGET_EXHAUSTED,
  type LockBudgetExhausted,
  type ReservationCommand,
  type ReservationLineBody,
  type ReservationOrderStatus,
  type TryOutcome,
} from './types';

export interface StockLevel {
  onHand: number;
  reserved: number;
}

/** One way of reaching the participant: in-process, the real service over HTTP, or a stub of it. */
export interface InventoryContractDriver {
  /** A routable id, used for orders and variants alike. */
  newId(): string;
  seedStock(variantId: string, onHand: number): Promise<void>;
  stockOf(variantId: string): Promise<StockLevel | null>;
  /** Holds the variant's stock row the way another transaction would, until the returned function runs. */
  lockStock(variantId: string): Promise<() => Promise<void>>;
  tryReserve(orderId: string, lines: ReservationLineBody[], holdUntil: Date): Promise<TryOutcome | LockBudgetExhausted>;
  command(orderId: string, command: ReservationCommand): Promise<CommandOutcome | LockBudgetExhausted>;
  statusOf(orderIds: string[]): Promise<Map<string, ReservationOrderStatus | null>>;
}

/** Orders and variants are named; the runner gives each name a fresh id per case. */
export type ContractStep =
  | { op: 'try'; order: string; lines: Record<string, number>; expect: TryOutcome | LockBudgetExhausted }
  | { op: ReservationCommand; order: string; expect: CommandOutcome | LockBudgetExhausted }
  | { op: 'status'; expect: Record<string, ReservationOrderStatus | null> }
  | { op: 'stock'; expect: Record<string, StockLevel | null> }
  | { op: 'lock'; variant: string }
  | { op: 'unlock'; variant: string };

type CheckedStep = Exclude<ContractStep, { op: 'lock' } | { op: 'unlock' }>;

export interface InventoryContractCase {
  name: string;
  /** On-hand per variant, seeded before the first step. A variant left out has no stock row. */
  stock: Record<string, number>;
  steps: ContractStep[];
}

type Header = ReservationOrderStatus | 'none';
type Op = 'try' | ReservationCommand;

const ON_HAND = 5;
const QUANTITY = 2;

const tryOne = (expect: TryOutcome | LockBudgetExhausted, order = 'order'): ContractStep => ({
  op: 'try',
  order,
  lines: { sku: QUANTITY },
  expect,
});
const run = (op: ReservationCommand, expect: CommandOutcome | LockBudgetExhausted, order = 'order'): ContractStep => ({
  op,
  order,
  expect,
});

const PATH_TO: Record<Header, ContractStep[]> = {
  none: [],
  HELD: [tryOne('RESERVED')],
  COMMITTED: [tryOne('RESERVED'), run('commit', 'APPLIED')],
  RELEASED: [tryOne('RESERVED'), run('release', 'APPLIED')],
  FENCED: [run('release', 'APPLIED')],
  RESTOCKED: [tryOne('RESERVED'), run('commit', 'APPLIED'), run('restock', 'APPLIED')],
};

const STOCK_AT: Record<Header, StockLevel> = {
  none: { onHand: ON_HAND, reserved: 0 },
  HELD: { onHand: ON_HAND, reserved: QUANTITY },
  COMMITTED: { onHand: ON_HAND - QUANTITY, reserved: 0 },
  RELEASED: { onHand: ON_HAND, reserved: 0 },
  FENCED: { onHand: ON_HAND, reserved: 0 },
  RESTOCKED: { onHand: ON_HAND, reserved: 0 },
};

// Written out rather than derived from the participant's fence, so changing the fence means changing this.
// A Try resent to a HELD order is answered RESERVED, not IDEMPOTENT: the caller only needs to know it holds.
const FENCE: Record<Header, Record<Op, [TryOutcome | CommandOutcome, Header]>> = {
  none: {
    try: ['RESERVED', 'HELD'],
    commit: ['CONFLICT', 'none'],
    release: ['APPLIED', 'FENCED'],
    restock: ['CONFLICT', 'none'],
  },
  HELD: {
    try: ['RESERVED', 'HELD'],
    commit: ['APPLIED', 'COMMITTED'],
    release: ['APPLIED', 'RELEASED'],
    restock: ['CONFLICT', 'HELD'],
  },
  COMMITTED: {
    try: ['CONFLICT', 'COMMITTED'],
    commit: ['IDEMPOTENT', 'COMMITTED'],
    release: ['CONFLICT', 'COMMITTED'],
    restock: ['APPLIED', 'RESTOCKED'],
  },
  RELEASED: {
    try: ['CONFLICT', 'RELEASED'],
    commit: ['CONFLICT', 'RELEASED'],
    release: ['IDEMPOTENT', 'RELEASED'],
    restock: ['CONFLICT', 'RELEASED'],
  },
  FENCED: {
    try: ['CONFLICT', 'FENCED'],
    commit: ['CONFLICT', 'FENCED'],
    release: ['IDEMPOTENT', 'FENCED'],
    restock: ['CONFLICT', 'FENCED'],
  },
  RESTOCKED: {
    try: ['CONFLICT', 'RESTOCKED'],
    commit: ['CONFLICT', 'RESTOCKED'],
    release: ['CONFLICT', 'RESTOCKED'],
    restock: ['IDEMPOTENT', 'RESTOCKED'],
  },
};

const headerOf = (header: Header): ReservationOrderStatus | null => (header === 'none' ? null : header);

const fenceCases: InventoryContractCase[] = (Object.keys(FENCE) as Header[]).flatMap((start) =>
  (Object.keys(FENCE[start]) as Op[]).map((op) => {
    const [outcome, after] = FENCE[start][op];
    const step: ContractStep = op === 'try' ? tryOne(outcome as TryOutcome) : run(op, outcome as CommandOutcome);
    return {
      name: `${op} on ${start === 'none' ? 'an order it never saw' : `a ${start} order`} answers ${outcome}, header ${after}`,
      stock: { sku: ON_HAND },
      steps: [
        ...PATH_TO[start],
        step,
        { op: 'status', expect: { order: headerOf(after) } },
        { op: 'stock', expect: { sku: STOCK_AT[after] } },
      ],
    };
  }),
);

// CONTENDED needs a lost optimistic race, which no sequence of calls can stage; the contention suites own it.
export const INVENTORY_CONTRACT_CASES: InventoryContractCase[] = [
  ...fenceCases,
  {
    name: 'a Try short on one line holds none of them and leaves no header',
    stock: { plenty: 5, scarce: 1 },
    steps: [
      { op: 'try', order: 'order', lines: { plenty: 2, scarce: 2 }, expect: 'OUT_OF_STOCK' },
      { op: 'status', expect: { order: null } },
      { op: 'stock', expect: { plenty: { onHand: 5, reserved: 0 }, scarce: { onHand: 1, reserved: 0 } } },
    ],
  },
  {
    name: 'a variant with no stock row is out of stock',
    stock: {},
    steps: [
      { op: 'try', order: 'order', lines: { unknown: 1 }, expect: 'OUT_OF_STOCK' },
      { op: 'status', expect: { order: null } },
      { op: 'stock', expect: { unknown: null } },
    ],
  },
  {
    name: 'the last unit goes to the first Try and the next order is refused',
    stock: { sku: 1 },
    steps: [
      { op: 'try', order: 'first', lines: { sku: 1 }, expect: 'RESERVED' },
      { op: 'try', order: 'second', lines: { sku: 1 }, expect: 'OUT_OF_STOCK' },
      { op: 'status', expect: { first: 'HELD', second: null } },
      { op: 'stock', expect: { sku: { onHand: 1, reserved: 1 } } },
    ],
  },
  {
    name: 'commit and restock move every line of the order',
    stock: { a: 5, b: 5 },
    steps: [
      { op: 'try', order: 'order', lines: { a: 2, b: 3 }, expect: 'RESERVED' },
      { op: 'stock', expect: { a: { onHand: 5, reserved: 2 }, b: { onHand: 5, reserved: 3 } } },
      run('commit', 'APPLIED'),
      { op: 'stock', expect: { a: { onHand: 3, reserved: 0 }, b: { onHand: 2, reserved: 0 } } },
      run('restock', 'APPLIED'),
      { op: 'stock', expect: { a: { onHand: 5, reserved: 0 }, b: { onHand: 5, reserved: 0 } } },
    ],
  },
  {
    name: 'release frees every line of the order',
    stock: { a: 5, b: 5 },
    steps: [
      { op: 'try', order: 'order', lines: { a: 2, b: 3 }, expect: 'RESERVED' },
      run('release', 'APPLIED'),
      { op: 'stock', expect: { a: { onHand: 5, reserved: 0 }, b: { onHand: 5, reserved: 0 } } },
    ],
  },
  {
    name: 'a refused Try leaves the order open to a fencing release',
    stock: { sku: 1 },
    steps: [
      { op: 'try', order: 'order', lines: { sku: 2 }, expect: 'OUT_OF_STOCK' },
      run('release', 'APPLIED'),
      { op: 'try', order: 'order', lines: { sku: 1 }, expect: 'CONFLICT' },
      { op: 'status', expect: { order: 'FENCED' } },
      { op: 'stock', expect: { sku: { onHand: 1, reserved: 0 } } },
    ],
  },
  {
    name: 'one status read answers every order in the batch',
    stock: { sku: 10 },
    steps: [
      { op: 'try', order: 'held', lines: { sku: 1 }, expect: 'RESERVED' },
      run('release', 'APPLIED', 'fenced'),
      { op: 'try', order: 'committed', lines: { sku: 1 }, expect: 'RESERVED' },
      run('commit', 'APPLIED', 'committed'),
      { op: 'status', expect: { held: 'HELD', fenced: 'FENCED', committed: 'COMMITTED', unseen: null } },
    ],
  },
  {
    name: 'a Try that outwaits its budget on a busy stock row answers LOCK_BUDGET_EXHAUSTED and leaves nothing behind',
    stock: { sku: ON_HAND },
    steps: [
      { op: 'lock', variant: 'sku' },
      tryOne(LOCK_BUDGET_EXHAUSTED),
      { op: 'unlock', variant: 'sku' },
      { op: 'status', expect: { order: null } },
      { op: 'stock', expect: { sku: STOCK_AT.none } },
      tryOne('RESERVED'),
    ],
  },
  {
    name: 'a commit stuck behind a busy stock row answers LOCK_BUDGET_EXHAUSTED and lands once the row is free',
    stock: { sku: ON_HAND },
    steps: [
      tryOne('RESERVED'),
      { op: 'lock', variant: 'sku' },
      run('commit', LOCK_BUDGET_EXHAUSTED),
      { op: 'unlock', variant: 'sku' },
      { op: 'status', expect: { order: 'HELD' } },
      { op: 'stock', expect: { sku: STOCK_AT.HELD } },
      run('commit', 'APPLIED'),
    ],
  },
];

export class ContractMismatch extends Error {
  constructor(step: number, op: string, expected: unknown, actual: unknown) {
    super(`step ${step} (${op}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    this.name = 'ContractMismatch';
  }
}

export async function runContractCase(driver: InventoryContractDriver, testCase: InventoryContractCase): Promise<void> {
  const orders = new Map<string, string>();
  const variants = new Map<string, string>();
  const idFor = (names: Map<string, string>, name: string): string => {
    let id = names.get(name);
    if (id === undefined) {
      id = driver.newId();
      names.set(name, id);
    }
    return id;
  };
  const order = (name: string) => idFor(orders, name);
  const variant = (name: string) => idFor(variants, name);

  for (const [name, onHand] of Object.entries(testCase.stock)) {
    await driver.seedStock(variant(name), onHand);
  }
  const holdUntil = new Date(Date.now() + 3_600_000);
  const unlocks = new Map<string, () => Promise<void>>();

  try {
    for (const [index, step] of testCase.steps.entries()) {
      if (step.op === 'lock') {
        unlocks.set(step.variant, await driver.lockStock(variant(step.variant)));
        continue;
      }
      if (step.op === 'unlock') {
        await unlocks.get(step.variant)?.();
        unlocks.delete(step.variant);
        continue;
      }
      const actual = await perform(step);
      if (!isDeepStrictEqual(actual, step.expect)) {
        throw new ContractMismatch(index + 1, step.op, step.expect, actual);
      }
    }
  } finally {
    // A lock left behind by a failed case would hold up the next case's reset.
    for (const unlock of unlocks.values()) await unlock();
  }

  async function perform(step: CheckedStep): Promise<unknown> {
    switch (step.op) {
      case 'try': {
        const lines = Object.entries(step.lines).map(([name, quantity]) => ({ variantId: variant(name), quantity }));
        return driver.tryReserve(order(step.order), lines, holdUntil);
      }
      case 'commit':
      case 'release':
      case 'restock':
        return driver.command(order(step.order), step.op);
      case 'status': {
        const names = Object.keys(step.expect);
        const statuses = await driver.statusOf(names.map(order));
        return Object.fromEntries(names.map((name) => [name, statuses.get(order(name))]));
      }
      case 'stock': {
        const names = Object.keys(step.expect);
        return Object.fromEntries(
          await Promise.all(names.map(async (name) => [name, await driver.stockOf(variant(name))])),
        );
      }
    }
  }
}
