import { isDeepStrictEqual } from 'node:util';
import { ContractMismatch } from '../common/contract-mismatch';
import {
  type CancelOutcome,
  type CaptureOutcome,
  type OpenSessionResponse,
  PROVIDER_UNAVAILABLE,
  type PaymentOrderStatus,
  type PaymentStatusEntry,
  type ProviderUnavailable,
  type SessionOutcome,
} from './types';

export interface SessionCharge {
  amountMinor: number;
  currency: string;
  expiresAt: Date;
}

/** One way of reaching the participant: in-process, the real service over HTTP, or a stub of it. */
export interface PaymentContractDriver {
  newId(): string;
  /** `PAYMENT_SESSION_MIN_TTL_SEC + PAYMENT_SESSION_EXPIRY_MARGIN_SEC` of the participant, in ms. */
  sessionFloorMs: number;
  openSession(orderId: string, charge: SessionCharge): Promise<OpenSessionResponse>;
  capture(orderId: string): Promise<CaptureOutcome | ProviderUnavailable>;
  cancel(orderId: string): Promise<CancelOutcome>;
  statusOf(orderIds: string[]): Promise<Map<string, PaymentStatusEntry>>;
  /** The buyer pays the session the order has open; resolves once the participant has recorded the hold. */
  authorize(orderId: string): Promise<void>;
  /** Stripe fails the order's next capture without applying it. */
  stripeFailsCapture(orderId: string): Promise<void>;
}

export interface ExpectedPaymentStatus extends Omit<PaymentStatusEntry, 'authorizedPaymentId'> {
  /** `opened` is the attempt the order's last OPENED answer named. */
  authorizedPaymentId: 'opened' | null;
}

/** Orders are named; the runner gives each name a fresh id per case. */
export type PaymentContractStep =
  | {
      op: 'open';
      order: string;
      expect: SessionOutcome;
      /** For OPENED: a fresh attempt, or the one the order's last OPENED named. Defaults to `new`. */
      attempt?: 'new' | 'same';
      amountMinor?: number;
      belowFloor?: boolean;
    }
  | { op: 'capture'; order: string; expect: CaptureOutcome | ProviderUnavailable }
  | { op: 'cancel'; order: string; expect: CancelOutcome }
  | { op: 'authorize'; order: string }
  | { op: 'stripeFailsCapture'; order: string }
  | { op: 'status'; expect: Record<string, ExpectedPaymentStatus> };

type CheckedStep = Exclude<PaymentContractStep, { op: 'authorize' } | { op: 'stripeFailsCapture' }>;

export interface PaymentContractCase {
  name: string;
  steps: PaymentContractStep[];
}

type Header = PaymentOrderStatus | 'none';
type Op = 'open' | 'capture' | 'cancel';

const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';

const open = (expect: SessionOutcome, attempt?: 'new' | 'same', order = 'order'): PaymentContractStep => ({
  op: 'open',
  order,
  expect,
  ...(attempt ? { attempt } : {}),
});
const capture = (expect: CaptureOutcome | ProviderUnavailable, order = 'order'): PaymentContractStep => ({
  op: 'capture',
  order,
  expect,
});
const cancel = (expect: CancelOutcome, order = 'order'): PaymentContractStep => ({ op: 'cancel', order, expect });
const authorize = (order = 'order'): PaymentContractStep => ({ op: 'authorize', order });

const PATH_TO: Record<Header, PaymentContractStep[]> = {
  none: [],
  OPEN: [open('OPENED')],
  AUTHORIZED: [open('OPENED'), authorize()],
  CAPTURED: [open('OPENED'), authorize(), capture('CAPTURED')],
  CANCELLED: [open('OPENED'), cancel('CANCELLED')],
  FENCED: [cancel('FENCED')],
};

const NOTHING: ExpectedPaymentStatus = {
  header: null,
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
};

const STATUS_AT: Record<Header, ExpectedPaymentStatus> = {
  none: NOTHING,
  OPEN: { ...NOTHING, header: 'OPEN' },
  AUTHORIZED: {
    header: 'AUTHORIZED',
    authorizedPaymentId: 'opened',
    hasAuthorizedAttempt: true,
    hasSucceededAttempt: false,
  },
  CAPTURED: {
    header: 'CAPTURED',
    authorizedPaymentId: 'opened',
    hasAuthorizedAttempt: false,
    hasSucceededAttempt: true,
  },
  CANCELLED: { ...NOTHING, header: 'CANCELLED' },
  FENCED: { ...NOTHING, header: 'FENCED' },
};

// Written out rather than derived from the participant's fence, so changing the fence means changing this.
// An open resent while the session is still open hands back the same attempt instead of a second one.
const FENCE: Record<Header, Record<Op, [SessionOutcome | CaptureOutcome | CancelOutcome, Header]>> = {
  none: { open: ['OPENED', 'OPEN'], capture: ['CONFLICT', 'none'], cancel: ['FENCED', 'FENCED'] },
  OPEN: { open: ['OPENED', 'OPEN'], capture: ['CONFLICT', 'OPEN'], cancel: ['CANCELLED', 'CANCELLED'] },
  AUTHORIZED: {
    open: ['CLOSED', 'AUTHORIZED'],
    capture: ['CAPTURED', 'CAPTURED'],
    cancel: ['CANCELLED', 'CANCELLED'],
  },
  CAPTURED: {
    open: ['CLOSED', 'CAPTURED'],
    capture: ['IDEMPOTENT', 'CAPTURED'],
    cancel: ['CAPTURED_CONFLICT', 'CAPTURED'],
  },
  CANCELLED: {
    open: ['CLOSED', 'CANCELLED'],
    capture: ['NOT_CAPTURABLE', 'CANCELLED'],
    cancel: ['IDEMPOTENT', 'CANCELLED'],
  },
  FENCED: { open: ['CLOSED', 'FENCED'], capture: ['NOT_CAPTURABLE', 'FENCED'], cancel: ['IDEMPOTENT', 'FENCED'] },
};

function stepFor(op: Op, start: Header, outcome: SessionOutcome | CaptureOutcome | CancelOutcome): PaymentContractStep {
  switch (op) {
    case 'open':
      return open(outcome as SessionOutcome, start === 'OPEN' ? 'same' : 'new');
    case 'capture':
      return capture(outcome as CaptureOutcome);
    case 'cancel':
      return cancel(outcome as CancelOutcome);
  }
}

const fenceCases: PaymentContractCase[] = (Object.keys(FENCE) as Header[]).flatMap((start) =>
  (Object.keys(FENCE[start]) as Op[]).map((op) => {
    const [outcome, after] = FENCE[start][op];
    return {
      name: `${op} on ${start === 'none' ? 'an order it never saw' : `a ${start} order`} answers ${outcome}, header ${after}`,
      steps: [...PATH_TO[start], stepFor(op, start, outcome), { op: 'status', expect: { order: STATUS_AT[after] } }],
    };
  }),
);

export const PAYMENT_CONTRACT_CASES: PaymentContractCase[] = [
  ...fenceCases,
  {
    name: 'an open expiring inside the session floor answers CLOSED and leaves no header',
    steps: [
      { op: 'open', order: 'order', expect: 'CLOSED', belowFloor: true },
      { op: 'status', expect: { order: NOTHING } },
    ],
  },
  {
    name: 'an open asking another charge than the locked one answers CLOSED and keeps the attempt',
    steps: [
      open('OPENED'),
      { op: 'open', order: 'order', expect: 'CLOSED', amountMinor: AMOUNT_MINOR + 1 },
      { op: 'status', expect: { order: STATUS_AT.OPEN } },
      open('OPENED', 'same'),
    ],
  },
  {
    name: 'a capture before the buyer paid answers CONFLICT and a later one captures',
    steps: [
      open('OPENED'),
      capture('CONFLICT'),
      authorize(),
      { op: 'status', expect: { order: STATUS_AT.AUTHORIZED } },
      capture('CAPTURED'),
      capture('IDEMPOTENT'),
      { op: 'status', expect: { order: STATUS_AT.CAPTURED } },
    ],
  },
  {
    name: 'a capture Stripe fails answers PROVIDER_UNAVAILABLE, keeps the hold, and a later one captures',
    steps: [
      open('OPENED'),
      authorize(),
      { op: 'stripeFailsCapture', order: 'order' },
      capture(PROVIDER_UNAVAILABLE),
      { op: 'status', expect: { order: STATUS_AT.AUTHORIZED } },
      capture('CAPTURED'),
    ],
  },
  {
    name: 'one status read answers every order in the batch',
    steps: [
      open('OPENED', 'new', 'open'),
      open('OPENED', 'new', 'held'),
      authorize('held'),
      open('OPENED', 'new', 'captured'),
      authorize('captured'),
      capture('CAPTURED', 'captured'),
      open('OPENED', 'new', 'voided'),
      authorize('voided'),
      cancel('CANCELLED', 'voided'),
      cancel('FENCED', 'fenced'),
      {
        op: 'status',
        expect: {
          unseen: STATUS_AT.none,
          open: STATUS_AT.OPEN,
          held: STATUS_AT.AUTHORIZED,
          captured: STATUS_AT.CAPTURED,
          voided: STATUS_AT.CANCELLED,
          fenced: STATUS_AT.FENCED,
        },
      },
    ],
  },
];

export async function runPaymentContractCase(
  driver: PaymentContractDriver,
  testCase: PaymentContractCase,
): Promise<void> {
  const orders = new Map<string, string>();
  const opened = new Map<string, string>();
  const order = (name: string): string => {
    let id = orders.get(name);
    if (id === undefined) {
      id = driver.newId();
      orders.set(name, id);
    }
    return id;
  };

  for (const [index, step] of testCase.steps.entries()) {
    if (step.op === 'authorize') {
      await driver.authorize(order(step.order));
      continue;
    }
    if (step.op === 'stripeFailsCapture') {
      await driver.stripeFailsCapture(order(step.order));
      continue;
    }
    const [expected, actual] = await perform(step);
    if (!isDeepStrictEqual(actual, expected)) {
      throw new ContractMismatch(index + 1, step.op, expected, actual);
    }
  }

  async function perform(step: CheckedStep): Promise<[unknown, unknown]> {
    switch (step.op) {
      case 'open': {
        const leadMs = step.belowFloor ? driver.sessionFloorMs - 1_000 : driver.sessionFloorMs + 3_600_000;
        const answer = await driver.openSession(order(step.order), {
          amountMinor: step.amountMinor ?? AMOUNT_MINOR,
          currency: CURRENCY,
          expiresAt: new Date(Date.now() + leadMs),
        });
        const expected =
          step.expect === 'OPENED' ? { outcome: 'OPENED', attempt: step.attempt ?? 'new' } : { outcome: 'CLOSED' };
        if (answer.outcome === 'CLOSED') return [expected, { outcome: 'CLOSED' }];
        const previous = opened.get(step.order);
        opened.set(step.order, answer.paymentId);
        return [expected, { outcome: 'OPENED', attempt: previous === answer.paymentId ? 'same' : 'new' }];
      }
      case 'capture':
        return [step.expect, await driver.capture(order(step.order))];
      case 'cancel':
        return [step.expect, await driver.cancel(order(step.order))];
      case 'status': {
        const names = Object.keys(step.expect);
        const statuses = await driver.statusOf(names.map(order));
        const actual = names.map((name) => {
          const entry = statuses.get(order(name));
          if (!entry) return [name, entry];
          const named = entry.authorizedPaymentId !== null && entry.authorizedPaymentId === opened.get(name);
          return [name, { ...entry, authorizedPaymentId: named ? 'opened' : entry.authorizedPaymentId }];
        });
        return [step.expect, Object.fromEntries(actual)];
      }
    }
  }
}
