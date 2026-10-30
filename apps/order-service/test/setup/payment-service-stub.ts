import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { isRoutableId } from '@jcool/id-codec';
import {
  CANCEL_OUTCOME_STATUS,
  CAPTURE_OUTCOME_STATUS,
  MAX_STATUS_BATCH,
  PAYMENTS_PREFIX,
  PROVIDER_UNAVAILABLE,
  PROVIDER_UNAVAILABLE_STATUS,
  SESSION_OUTCOME_STATUS,
  type CancelOutcome,
  type CaptureOutcome,
  type OpenSessionResponse,
  type PaymentOrderStatus,
  type PaymentStatusEntry,
} from '@jcool/internal-contracts';
import {
  PAYMENT_AUTHORIZED_EVENT,
  paymentAuthorizedPayload,
} from '@jcool/internal-contracts/events/payment-authorized';
import { ORDER_EVENTS_QUEUE, orderEventsJobOptions } from '@jcool/internal-contracts/queues/order-events';
import { type DomainEventJob, buildJobOptions, jobIdFor } from '@jcool/messaging';
import { testId } from './id-service-stub';
import { workerRedisUrl } from './worker-resources';

export type PaymentStubRoute = 'session' | 'capture' | 'cancel' | 'status';

export type StubAttemptStatus = 'PENDING' | 'AUTHORIZED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'VOIDED';

export interface StubAttempt {
  paymentId: string;
  orderId: string;
  providerSessionId: string;
  amountMinor: number;
  currency: string;
  expiresAt: Date;
  status: StubAttemptStatus;
}

export interface StubPaymentHeader {
  orderId: string;
  status: PaymentOrderStatus;
  /** Null only on a FENCED header, as on the real table. */
  amountMinor: number | null;
  currency: string | null;
}

export interface PaymentStubOptions {
  /** `PAYMENT_SESSION_MIN_TTL_SEC + PAYMENT_SESSION_EXPIRY_MARGIN_SEC` of the real service, in ms. */
  sessionFloorMs: number;
}

/** `Infinity` keeps the fault on until `clearFault` or `reset`. */
export interface FaultOptions {
  times?: number;
}

type Fault = { remaining: number } & (
  { kind: 'status'; status: number } | { kind: 'providerDown' } | { kind: 'hang'; arrived: () => void }
);

// The real service's defaults: 1800s that Stripe asks for, plus a 120s margin.
const DEFAULT_OPTIONS: PaymentStubOptions = { sessionFloorMs: 1_920_000 };
const RETRY_AFTER_SEC = '1';

/**
 * Stands in for the payment-service's internal API. Headers and attempts live in memory and follow
 * the shared case table in `@jcool/internal-contracts`; `payment-stub-contract` keeps the two from
 * drifting. The buyer's side is `authorize`, which also publishes `payment.authorized` the way the
 * service's relay would. One per worker process, wiped with the database before every test.
 */
export class PaymentServiceStub {
  private readonly headers = new Map<string, StubPaymentHeader>();
  private readonly attempts = new Map<string, StubAttempt[]>();
  private readonly captures = new Map<string, number>();
  private readonly statusOverrides = new Map<string, PaymentStatusEntry>();
  private readonly droppedHolds = new Set<string>();
  private readonly published = new Map<string, DomainEventJob>();
  private readonly faults = new Map<PaymentStubRoute, Fault>();
  private readonly counts = new Map<PaymentStubRoute, number>();
  private readonly hanging = new Set<ServerResponse>();
  private options: PaymentStubOptions = { ...DEFAULT_OPTIONS };
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  static async start(): Promise<PaymentServiceStub> {
    const stub = new PaymentServiceStub();
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stub.server.unref();
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get sessionFloorMs(): number {
    return this.options.sessionFloorMs;
  }

  configure(options: Partial<PaymentStubOptions>): void {
    this.options = { ...this.options, ...options };
  }

  headerOf(orderId: string): StubPaymentHeader | undefined {
    const header = this.headers.get(orderId);
    return header && { ...header };
  }

  headersList(): StubPaymentHeader[] {
    return [...this.headers.values()].map((header) => ({ ...header }));
  }

  attemptsOf(orderId?: string): StubAttempt[] {
    const attempts = orderId === undefined ? [...this.attempts.values()].flat() : (this.attempts.get(orderId) ?? []);
    return attempts.map((attempt) => ({ ...attempt }));
  }

  /** The order's newest attempt, the one `/pay` handed the buyer. */
  sessionFor(orderId: string): StubAttempt | undefined {
    return this.attemptsOf(orderId).at(-1);
  }

  /** Captures actually applied, the count Stripe would see; retries answered IDEMPOTENT add nothing. */
  providerCaptures(orderId: string): number {
    return this.captures.get(orderId) ?? 0;
  }

  /**
   * The buyer pays the open session: the header turns AUTHORIZED on the current attempt and
   * `payment.authorized` lands on `order-events` in this worker's Redis, under the spec's prefix.
   * A charge passed here goes into the event only, to stage a report payment would not back.
   */
  async authorize(orderId: string, charge: { amountMinor?: number; currency?: string } = {}): Promise<string> {
    const header = this.headers.get(orderId);
    const attempt = this.attempts.get(orderId)?.at(-1);
    if (header?.status !== 'OPEN' || attempt?.status !== 'PENDING') {
      throw new Error(`order ${orderId} has no open session to authorize`);
    }
    attempt.status = 'AUTHORIZED';
    header.status = 'AUTHORIZED';
    return this.publishAuthorized(orderId, attempt, charge);
  }

  /**
   * The buyer got through after the order's cancel closed the header but before its session expired
   * at Stripe: payment records the hold under the CANCELLED header and still publishes it, leaving the
   * void to the late run. The stub expires a session at once, so the race is staged after the fact.
   */
  async authorizeLate(orderId: string): Promise<string> {
    const header = this.headers.get(orderId);
    const attempt = this.attempts.get(orderId)?.at(-1);
    if (header?.status !== 'CANCELLED' || attempt?.status !== 'EXPIRED') {
      throw new Error(`order ${orderId} has no session its cancel just expired`);
    }
    attempt.status = 'AUTHORIZED';
    return this.publishAuthorized(orderId, attempt, {});
  }

  private async publishAuthorized(
    orderId: string,
    attempt: StubAttempt,
    charge: { amountMinor?: number; currency?: string },
  ): Promise<string> {
    const authorizedAt = new Date();
    const outboxId = testId();
    const job: DomainEventJob = {
      outboxId,
      aggregateType: 'Payment',
      aggregateId: attempt.paymentId,
      eventType: PAYMENT_AUTHORIZED_EVENT,
      payload: {
        ...paymentAuthorizedPayload({
          paymentId: attempt.paymentId,
          orderId,
          amountMinor: charge.amountMinor ?? attempt.amountMinor,
          currency: charge.currency ?? attempt.currency,
          authorizedAt,
        }),
      },
      occurredAt: authorizedAt.toISOString(),
      traceparent: null,
    };
    await publish(job);
    this.published.set(orderId, job);
    return attempt.paymentId;
  }

  /** The last `payment.authorized` published for the order, for a test that hands it to the processor itself. */
  authorizedJob(orderId: string): DomainEventJob {
    const job = this.published.get(orderId);
    if (!job) throw new Error(`no payment.authorized published for order ${orderId}`);
    return job;
  }

  /** Pins what `/status` answers for the order, whatever the header says: a state payment would never report. */
  setStatus(orderId: string, entry: PaymentStatusEntry): void {
    this.statusOverrides.set(orderId, { ...entry });
  }

  clearStatus(orderId: string): void {
    this.statusOverrides.delete(orderId);
  }

  /** The card hold lapses at Stripe: the next capture finds nothing to take, as the real service does. */
  dropHold(orderId: string): void {
    this.droppedHolds.add(orderId);
  }

  /** Answers the next `times` calls to the route with a bare `status`; nothing is applied. */
  fail(route: PaymentStubRoute, status: number, { times = 1 }: FaultOptions = {}): void {
    this.faults.set(route, { kind: 'status', status, remaining: times });
  }

  /** Answers the next `times` calls with the coded 503 the real service sends while Stripe is away. */
  providerDown(route: PaymentStubRoute, { times = 1 }: FaultOptions = {}): void {
    this.faults.set(route, { kind: 'providerDown', remaining: times });
  }

  /** Never answers the next `times` calls, so only the caller's deadline ends them; nothing is applied. */
  hang(route: PaymentStubRoute, { times = 1 }: FaultOptions = {}): { reached: Promise<void> } {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    this.faults.set(route, { kind: 'hang', arrived, remaining: times });
    return { reached };
  }

  clearFault(route: PaymentStubRoute): void {
    this.faults.delete(route);
  }

  /** Every request that reached the route, faulted ones included. */
  calls(route: PaymentStubRoute): number {
    return this.counts.get(route) ?? 0;
  }

  reset(): void {
    this.headers.clear();
    this.attempts.clear();
    this.captures.clear();
    this.statusOverrides.clear();
    this.droppedHolds.clear();
    this.published.clear();
    this.faults.clear();
    this.counts.clear();
    this.options = { ...DEFAULT_OPTIONS };
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  openSession(orderId: string, amountMinor: number, currency: string, expiresAt: Date): OpenSessionResponse {
    if (expiresAt.getTime() < Date.now() + this.options.sessionFloorMs) return { outcome: 'CLOSED' };
    const charge = { amountMinor, currency: currency.toUpperCase() };

    let header = this.headers.get(orderId);
    if (!header) {
      header = { orderId, status: 'OPEN', ...charge };
      this.headers.set(orderId, header);
    }
    if (header.status !== 'OPEN') return { outcome: 'CLOSED' };
    if (header.amountMinor !== charge.amountMinor || header.currency !== charge.currency) return { outcome: 'CLOSED' };

    // A resend while the session is still open gets the same attempt back, without a fresh client secret.
    const current = this.attempts.get(orderId)?.at(-1);
    if (current?.status === 'PENDING') {
      return {
        outcome: 'OPENED',
        paymentId: current.paymentId,
        providerSessionId: current.providerSessionId,
        redirectUrl: redirectUrlOf(current.providerSessionId),
      };
    }

    const paymentId = testId();
    const providerSessionId = `cs_stub_${paymentId}`;
    const attempt: StubAttempt = { paymentId, orderId, providerSessionId, ...charge, expiresAt, status: 'PENDING' };
    this.attempts.set(orderId, [...(this.attempts.get(orderId) ?? []), attempt]);
    return {
      outcome: 'OPENED',
      paymentId,
      providerSessionId,
      redirectUrl: redirectUrlOf(providerSessionId),
      clientSecret: `${providerSessionId}_secret`,
    };
  }

  capture(orderId: string): CaptureOutcome {
    const header = this.headers.get(orderId);
    switch (header?.status) {
      case undefined:
      case 'OPEN':
        return 'CONFLICT';
      case 'CAPTURED':
        return 'IDEMPOTENT';
      case 'CANCELLED':
      case 'FENCED':
        return 'NOT_CAPTURABLE';
      case 'AUTHORIZED': {
        const attempt = this.attemptIn(orderId, 'AUTHORIZED');
        if (this.droppedHolds.has(orderId)) {
          attempt.status = 'FAILED';
          header.status = 'CANCELLED';
          return 'NOT_CAPTURABLE';
        }
        attempt.status = 'SUCCEEDED';
        this.captures.set(orderId, this.providerCaptures(orderId) + 1);
        header.status = 'CAPTURED';
        return 'CAPTURED';
      }
    }
  }

  cancel(orderId: string): CancelOutcome {
    const header = this.headers.get(orderId);
    switch (header?.status) {
      case undefined:
        this.headers.set(orderId, { orderId, status: 'FENCED', amountMinor: null, currency: null });
        return 'FENCED';
      case 'CAPTURED':
        return 'CAPTURED_CONFLICT';
      // A repeat still lets go of anything left open under the header, as the real rescan does.
      case 'CANCELLED':
      case 'FENCED':
        this.release(orderId);
        return 'IDEMPOTENT';
      case 'OPEN':
      case 'AUTHORIZED':
        this.release(orderId);
        header.status = 'CANCELLED';
        return 'CANCELLED';
    }
  }

  private release(orderId: string): void {
    for (const attempt of this.attempts.get(orderId) ?? []) {
      if (attempt.status === 'PENDING') attempt.status = 'EXPIRED';
      if (attempt.status === 'AUTHORIZED') attempt.status = 'VOIDED';
    }
  }

  statusOf(orderIds: string[]): Record<string, PaymentStatusEntry> {
    return Object.fromEntries(orderIds.map((orderId) => [orderId, this.statusEntry(orderId)]));
  }

  private statusEntry(orderId: string): PaymentStatusEntry {
    const pinned = this.statusOverrides.get(orderId);
    if (pinned) return { ...pinned };
    const attempts = this.attempts.get(orderId) ?? [];
    const holding = attempts.findLast((attempt) => attempt.status === 'AUTHORIZED' || attempt.status === 'SUCCEEDED');
    return {
      header: this.headers.get(orderId)?.status ?? null,
      authorizedPaymentId: holding?.paymentId ?? null,
      hasAuthorizedAttempt: attempts.some((attempt) => attempt.status === 'AUTHORIZED'),
      hasSucceededAttempt: attempts.some((attempt) => attempt.status === 'SUCCEEDED'),
    };
  }

  private attemptIn(orderId: string, status: StubAttemptStatus): StubAttempt {
    const attempt = this.attempts.get(orderId)?.find((candidate) => candidate.status === status);
    if (!attempt) throw new Error(`order ${orderId} is ${this.headers.get(orderId)?.status} with no ${status} attempt`);
    return attempt;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => this.answer(req, res, raw));
  }

  private answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const route = req.method === 'POST' ? routeOf(req.url ?? '') : null;
    if (!route) return void reply(res, 404, { statusCode: 404, message: 'Not Found' });
    this.counts.set(route.name, this.calls(route.name) + 1);

    const fault = this.faults.get(route.name);
    if (fault) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.faults.delete(route.name);
      if (fault.kind === 'status') {
        const headers: Record<string, string> = fault.status === 503 ? { 'retry-after': RETRY_AFTER_SEC } : {};
        return void reply(res, fault.status, { statusCode: fault.status }, headers);
      }
      if (fault.kind === 'providerDown') {
        const statusCode = PROVIDER_UNAVAILABLE_STATUS;
        const body = { statusCode, code: PROVIDER_UNAVAILABLE, message: 'Service unavailable' };
        return void reply(res, statusCode, body, { 'retry-after': RETRY_AFTER_SEC });
      }
      fault.arrived();
      this.hanging.add(res);
      res.on('close', () => this.hanging.delete(res));
      return;
    }

    // The real controller's order: caller token guard, then the id pipe, then the body.
    if (req.headers.authorization !== `Bearer ${requiredEnv('PAYMENT_SERVICE_TOKEN')}`) {
      return void reply(res, 401, { statusCode: 401, message: 'Unauthorized' });
    }
    if (route.name !== 'status' && !isRoutableId(route.orderId)) return void badRequest(res);
    const body = parse(raw);

    switch (route.name) {
      case 'status':
        if (!isStatusBody(body)) return void badRequest(res);
        return void reply(res, 200, { statuses: this.statusOf(body.orderIds) });
      case 'session': {
        if (!isSessionBody(body)) return void badRequest(res);
        const answer = this.openSession(route.orderId, body.amountMinor, body.currency, new Date(body.expiresAt));
        return void reply(res, SESSION_OUTCOME_STATUS[answer.outcome], answer);
      }
      case 'capture': {
        const outcome = this.capture(route.orderId);
        return void reply(res, CAPTURE_OUTCOME_STATUS[outcome], { outcome });
      }
      case 'cancel': {
        const outcome = this.cancel(route.orderId);
        return void reply(res, CANCEL_OUTCOME_STATUS[outcome], { outcome });
      }
    }
  }
}

type Route = { name: 'status' } | { name: Exclude<PaymentStubRoute, 'status'>; orderId: string };

function routeOf(path: string): Route | null {
  if (path === `/${PAYMENTS_PREFIX}/status`) return { name: 'status' };
  const match = new RegExp(`^/${PAYMENTS_PREFIX}/([^/]+)/(session|capture|cancel)$`).exec(path);
  if (!match) return null;
  return { name: match[2] as 'session' | 'capture' | 'cancel', orderId: decodeURIComponent(match[1]) };
}

const redirectUrlOf = (providerSessionId: string) => `https://checkout.stripe.test/c/pay/${providerSessionId}`;

async function publish(job: DomainEventJob): Promise<void> {
  // A connection per publish: the stub outlives every app in the worker, so it holds nothing open.
  const connection = new Redis(workerRedisUrl(), { maxRetriesPerRequest: null });
  const queue = new Queue<DomainEventJob>(ORDER_EVENTS_QUEUE, {
    connection,
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
    defaultJobOptions: buildJobOptions(
      envInt('QUEUE_CONSUMER_ATTEMPTS', 8),
      envInt('QUEUE_CONSUMER_BACKOFF_MS', 1_000),
    ),
  });
  try {
    await queue.add(job.eventType, job, {
      jobId: jobIdFor(job.outboxId),
      ...orderEventsJobOptions(job.eventType, envInt('ORDER_PAID_CONSUMER_ATTEMPTS', 15)),
    });
  } finally {
    await queue.close();
    await connection.quit();
  }
}

function parse(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isStatusBody(body: unknown): body is { orderIds: string[] } {
  if (!isRecord(body) || !Array.isArray(body.orderIds)) return false;
  const { orderIds } = body;
  return orderIds.length > 0 && orderIds.length <= MAX_STATUS_BATCH && orderIds.every(isRoutableId);
}

function isSessionBody(body: unknown): body is { amountMinor: number; currency: string; expiresAt: string } {
  if (!isRecord(body) || Object.keys(body).some((key) => !['amountMinor', 'currency', 'expiresAt'].includes(key))) {
    return false;
  }
  const { amountMinor, currency, expiresAt } = body;
  return (
    Number.isInteger(amountMinor) &&
    (amountMinor as number) >= 1 &&
    typeof currency === 'string' &&
    /^[A-Za-z]{3}$/.test(currency) &&
    typeof expiresAt === 'string' &&
    !Number.isNaN(Date.parse(expiresAt))
  );
}

function badRequest(res: ServerResponse): void {
  reply(res, 400, { statusCode: 400, message: 'Bad Request' });
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

// Read per call, from the same env the app validates, so the stub can never trust a different value.
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set for the e2e run`);
  return value;
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined ? fallback : Number(value);
}

let started: Promise<PaymentServiceStub> | undefined;

export function paymentServiceStub(): Promise<PaymentServiceStub> {
  started ??= PaymentServiceStub.start();
  return started;
}
