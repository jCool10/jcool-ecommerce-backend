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
  type RefundOutcome,
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
  refund(orderId: string, requestedBy: string): Promise<RefundOutcome | ProviderUnavailable>;
  statusOf(orderIds: string[]): Promise<Map<string, PaymentStatusEntry>>;
  /** The buyer pays the session the order has open; resolves once the participant has recorded the hold. */
  authorize(orderId: string): Promise<void>;
  /** Stripe fails the order's next capture without applying it. */
  stripeFailsCapture(orderId: string): Promise<void>;
  /** Stripe holds the order's next refund as pending, and keeps it so. */
  stripeRefundPending(orderId: string): Promise<void>;
  /** Stripe fails the order's next refund. */
  stripeFailsRefund(orderId: string): Promise<void>;
  /** Someone refunds the order's whole charge outside the shop, with no metadata. */
  refundOutOfBand(orderId: string): Promise<void>;
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
  | { op: 'refund'; order: string; expect: RefundOutcome | ProviderUnavailable }
  | { op: ArrangeOp; order: string }
  | { op: 'status'; expect: Record<string, ExpectedPaymentStatus> };

type ArrangeOp = 'authorize' | 'stripeFailsCapture' | 'stripeRefundPending' | 'stripeFailsRefund' | 'refundOutOfBand';

const ARRANGE_OPS: ReadonlySet<string> = new Set<ArrangeOp>([
  'authorize',
  'stripeFailsCapture',
  'stripeRefundPending',
  'stripeFailsRefund',
  'refundOutOfBand',
]);

type ArrangeStep = Extract<PaymentContractStep, { op: ArrangeOp }>;
type CheckedStep = Exclude<PaymentContractStep, ArrangeStep>;

const isArrangeStep = (step: PaymentContractStep): step is ArrangeStep => ARRANGE_OPS.has(step.op);

export interface PaymentContractCase {
  name: string;
  steps: PaymentContractStep[];
}

type Header = PaymentOrderStatus | 'none';
type Op = 'open' | 'capture' | 'cancel' | 'refund';
type Outcome = SessionOutcome | CaptureOutcome | CancelOutcome | RefundOutcome;

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
const refund = (expect: RefundOutcome | ProviderUnavailable, order = 'order'): PaymentContractStep => ({
  op: 'refund',
  order,
  expect,
});
const arrange = (op: ArrangeOp, order = 'order'): PaymentContractStep => ({ op, order });
const authorize = (order = 'order'): PaymentContractStep => arrange('authorize', order);

const CAPTURED_PATH = [open('OPENED'), authorize(), capture('CAPTURED')];

const PATH_TO: Record<Header, PaymentContractStep[]> = {
  none: [],
  OPEN: [open('OPENED')],
  AUTHORIZED: [open('OPENED'), authorize()],
  CAPTURED: CAPTURED_PATH,
  CANCELLED: [open('OPENED'), cancel('CANCELLED')],
  FENCED: [cancel('FENCED')],
  REFUNDING: [...CAPTURED_PATH, arrange('stripeRefundPending'), refund('PENDING')],
  REFUNDED: [...CAPTURED_PATH, refund('REFUNDED')],
  REFUND_FAILED: [...CAPTURED_PATH, arrange('stripeFailsRefund'), refund('REFUND_FAILED')],
};

const NOTHING: ExpectedPaymentStatus = {
  header: null,
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
};

// A refund leaves the captured attempt SUCCEEDED: the money was taken, and the refund is its own fact.
const captured = (header: PaymentOrderStatus): ExpectedPaymentStatus => ({
  header,
  authorizedPaymentId: 'opened',
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: true,
});

const STATUS_AT: Record<Header, ExpectedPaymentStatus> = {
  none: NOTHING,
  OPEN: { ...NOTHING, header: 'OPEN' },
  AUTHORIZED: {
    header: 'AUTHORIZED',
    authorizedPaymentId: 'opened',
    hasAuthorizedAttempt: true,
    hasSucceededAttempt: false,
  },
  CAPTURED: captured('CAPTURED'),
  CANCELLED: { ...NOTHING, header: 'CANCELLED' },
  FENCED: { ...NOTHING, header: 'FENCED' },
  REFUNDING: captured('REFUNDING'),
  REFUNDED: captured('REFUNDED'),
  REFUND_FAILED: captured('REFUND_FAILED'),
};

const NOT_REFUNDABLE = (header: Header): [RefundOutcome, Header] => ['NOT_REFUNDABLE', header];

// Money was captured under every refund header: an open is closed, a capture already happened and a
// cancel is too late. A refund Stripe still holds stays pending until Stripe settles it.
const AFTER_CAPTURE = (header: Header, refundAnswer: RefundOutcome): Record<Op, [Outcome, Header]> => ({
  open: ['CLOSED', header],
  capture: ['IDEMPOTENT', header],
  cancel: ['CAPTURED_CONFLICT', header],
  refund: [refundAnswer, header],
});

// Written out rather than derived from the participant's fence, so changing the fence means changing this.
// An open resent while the session is still open hands back the same attempt instead of a second one.
const FENCE: Record<Header, Record<Op, [Outcome, Header]>> = {
  none: {
    open: ['OPENED', 'OPEN'],
    capture: ['CONFLICT', 'none'],
    cancel: ['FENCED', 'FENCED'],
    refund: NOT_REFUNDABLE('none'),
  },
  OPEN: {
    open: ['OPENED', 'OPEN'],
    capture: ['CONFLICT', 'OPEN'],
    cancel: ['CANCELLED', 'CANCELLED'],
    refund: NOT_REFUNDABLE('OPEN'),
  },
  AUTHORIZED: {
    open: ['CLOSED', 'AUTHORIZED'],
    capture: ['CAPTURED', 'CAPTURED'],
    cancel: ['CANCELLED', 'CANCELLED'],
    refund: NOT_REFUNDABLE('AUTHORIZED'),
  },
  CAPTURED: {
    open: ['CLOSED', 'CAPTURED'],
    capture: ['IDEMPOTENT', 'CAPTURED'],
    cancel: ['CAPTURED_CONFLICT', 'CAPTURED'],
    refund: ['REFUNDED', 'REFUNDED'],
  },
  CANCELLED: {
    open: ['CLOSED', 'CANCELLED'],
    capture: ['NOT_CAPTURABLE', 'CANCELLED'],
    cancel: ['IDEMPOTENT', 'CANCELLED'],
    refund: NOT_REFUNDABLE('CANCELLED'),
  },
  FENCED: {
    open: ['CLOSED', 'FENCED'],
    capture: ['NOT_CAPTURABLE', 'FENCED'],
    cancel: ['IDEMPOTENT', 'FENCED'],
    refund: NOT_REFUNDABLE('FENCED'),
  },
  REFUNDING: AFTER_CAPTURE('REFUNDING', 'PENDING'),
  REFUNDED: AFTER_CAPTURE('REFUNDED', 'IDEMPOTENT'),
  REFUND_FAILED: AFTER_CAPTURE('REFUND_FAILED', 'REFUND_FAILED'),
};

function stepFor(op: Op, start: Header, outcome: Outcome): PaymentContractStep {
  switch (op) {
    case 'open':
      return open(outcome as SessionOutcome, start === 'OPEN' ? 'same' : 'new');
    case 'capture':
      return capture(outcome as CaptureOutcome);
    case 'cancel':
      return cancel(outcome as CancelOutcome);
    case 'refund':
      return refund(outcome as RefundOutcome);
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
    name: 'a refund answers REFUNDED once, and every repeat IDEMPOTENT',
    steps: [
      ...CAPTURED_PATH,
      refund('REFUNDED'),
      refund('IDEMPOTENT'),
      refund('IDEMPOTENT'),
      { op: 'status', expect: { order: STATUS_AT.REFUNDED } },
    ],
  },
  {
    name: 'a refund Stripe fails answers REFUND_FAILED, and so does every repeat',
    steps: [
      ...CAPTURED_PATH,
      arrange('stripeFailsRefund'),
      refund('REFUND_FAILED'),
      refund('REFUND_FAILED'),
      { op: 'status', expect: { order: STATUS_AT.REFUND_FAILED } },
    ],
  },
  {
    name: 'a full refund made outside the shop is adopted by the shop refund, which answers REFUNDED',
    steps: [
      ...CAPTURED_PATH,
      arrange('refundOutOfBand'),
      { op: 'status', expect: { order: STATUS_AT.CAPTURED } },
      refund('REFUNDED'),
      refund('IDEMPOTENT'),
      { op: 'status', expect: { order: STATUS_AT.REFUNDED } },
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
      open('OPENED', 'new', 'refunded'),
      authorize('refunded'),
      capture('CAPTURED', 'refunded'),
      refund('REFUNDED', 'refunded'),
      {
        op: 'status',
        expect: {
          unseen: STATUS_AT.none,
          open: STATUS_AT.OPEN,
          held: STATUS_AT.AUTHORIZED,
          captured: STATUS_AT.CAPTURED,
          voided: STATUS_AT.CANCELLED,
          fenced: STATUS_AT.FENCED,
          refunded: STATUS_AT.REFUNDED,
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
  const admin = driver.newId();
  const order = (name: string): string => {
    let id = orders.get(name);
    if (id === undefined) {
      id = driver.newId();
      orders.set(name, id);
    }
    return id;
  };

  for (const [index, step] of testCase.steps.entries()) {
    if (isArrangeStep(step)) {
      await driver[step.op](order(step.order));
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
      case 'refund':
        return [step.expect, await driver.refund(order(step.order), admin)];
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
