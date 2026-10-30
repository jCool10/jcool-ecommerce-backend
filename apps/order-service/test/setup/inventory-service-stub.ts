import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isRoutableId } from '@jcool/id-codec';
import {
  COMMAND_OUTCOME_STATUS,
  LOCK_BUDGET_EXHAUSTED,
  LOCK_BUDGET_EXHAUSTED_STATUS,
  MAX_STATUS_BATCH,
  RESERVATIONS_PREFIX,
  RESERVATION_COMMANDS,
  TRY_OUTCOME_STATUS,
  type CommandOutcome,
  type LockBudgetExhausted,
  type ReservationCommand,
  type ReservationLineBody,
  type ReservationOrderStatus,
  type TryOutcome,
} from '@jcool/internal-contracts';

export type InventoryStubRoute = 'try' | ReservationCommand | 'status';

export type StubHoldStatus = 'HELD' | 'COMMITTED' | 'RELEASED' | 'RESTOCKED';

export interface StubHold {
  orderId: string;
  variantId: string;
  quantity: number;
  status: StubHoldStatus;
}

export interface StubStockLevel {
  variantId: string;
  onHand: number;
  reserved: number;
}

export interface StubHeader {
  orderId: string;
  status: ReservationOrderStatus;
  holdUntil: Date | null;
}

/** `Infinity` keeps the fault on until `clearFault` or `reset`. */
export interface FaultOptions {
  times?: number;
}

type Fault = { remaining: number } & (
  { kind: 'status'; status: number } | { kind: 'busy' } | { kind: 'hang'; arrived: () => void }
);

/**
 * Stands in for the inventory-service's internal API. Stock and the per-order fence live in memory
 * and follow the shared case table in `@jcool/internal-contracts`; `inventory-stub-contract` keeps
 * the two from drifting. One per worker process, wiped with the database before every test.
 */
export class InventoryServiceStub {
  private readonly stock = new Map<string, StubStockLevel>();
  private readonly headers = new Map<string, StubHeader>();
  private readonly holds = new Map<string, StubHold[]>();
  private readonly locked = new Set<string>();
  private readonly faults = new Map<InventoryStubRoute, Fault>();
  private readonly counts = new Map<InventoryStubRoute, number>();
  private readonly hanging = new Set<ServerResponse>();
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  static async start(): Promise<InventoryServiceStub> {
    const stub = new InventoryServiceStub();
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stub.server.unref();
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  seedStock(variantId: string, onHand: number, reserved = 0): void {
    this.stock.set(variantId, { variantId, onHand, reserved });
  }

  stockOf(variantId: string): StubStockLevel | undefined {
    const level = this.stock.get(variantId);
    return level && { ...level };
  }

  stockLevels(): StubStockLevel[] {
    return [...this.stock.values()].map((level) => ({ ...level }));
  }

  headerOf(orderId: string): StubHeader | undefined {
    const header = this.headers.get(orderId);
    return header && { ...header };
  }

  headersList(): StubHeader[] {
    return [...this.headers.values()].map((header) => ({ ...header }));
  }

  /** Writes the header alone, stock untouched: how a test stages a state the saga would never leave. */
  setHeader(orderId: string, status: ReservationOrderStatus): void {
    this.headers.set(orderId, { orderId, status, holdUntil: null });
  }

  holdsOf(orderId?: string): StubHold[] {
    const holds = orderId === undefined ? [...this.holds.values()].flat() : (this.holds.get(orderId) ?? []);
    return holds.map((hold) => ({ ...hold }));
  }

  heldCount(variantId: string): number {
    return this.holdsOf().filter((hold) => hold.variantId === variantId && hold.status === 'HELD').length;
  }

  /** Answers the next `times` calls to the route with a bare `status`. */
  fail(route: InventoryStubRoute, status: number, { times = 1 }: FaultOptions = {}): void {
    this.faults.set(route, { kind: 'status', status, remaining: times });
  }

  /** Answers the next `times` calls to the route as rows held past the lock budget; nothing is applied. */
  busy(route: InventoryStubRoute, { times = 1 }: FaultOptions = {}): void {
    this.faults.set(route, { kind: 'busy', remaining: times });
  }

  /**
   * Holds the variant's stock row until the returned function runs: what moves its stock answers busy
   * rows, while a header-only answer still goes through, as on the real service.
   */
  lockStock(variantId: string): () => void {
    this.locked.add(variantId);
    return () => this.locked.delete(variantId);
  }

  /** Never answers the next `times` calls, so only the caller's deadline ends them; nothing is applied. */
  hang(route: InventoryStubRoute, { times = 1 }: FaultOptions = {}): { reached: Promise<void> } {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    this.faults.set(route, { kind: 'hang', arrived, remaining: times });
    return { reached };
  }

  clearFault(route: InventoryStubRoute): void {
    this.faults.delete(route);
  }

  /** Every request that reached the route, faulted ones included. */
  calls(route: InventoryStubRoute): number {
    return this.counts.get(route) ?? 0;
  }

  reset(): void {
    this.stock.clear();
    this.headers.clear();
    this.holds.clear();
    this.locked.clear();
    this.faults.clear();
    this.counts.clear();
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  tryReserve(orderId: string, lines: ReservationLineBody[], holdUntil: Date): TryOutcome | LockBudgetExhausted {
    const header = this.headers.get(orderId);
    if (header) return header.status === 'HELD' ? 'RESERVED' : 'CONFLICT';
    // The real Try waits on the row before it can read what is left, so a shortfall answers busy too.
    if (lines.some(({ variantId }) => this.locked.has(variantId))) return LOCK_BUDGET_EXHAUSTED;

    // All lines or none: checked in full before any is held.
    const picked: Array<[StubStockLevel, number]> = [];
    for (const { variantId, quantity } of lines) {
      const level = this.stock.get(variantId);
      if (!level || level.onHand - level.reserved < quantity) return 'OUT_OF_STOCK';
      picked.push([level, quantity]);
    }

    for (const [level, quantity] of picked) level.reserved += quantity;
    this.headers.set(orderId, { orderId, status: 'HELD', holdUntil });
    this.holds.set(
      orderId,
      lines.map(({ variantId, quantity }) => ({ orderId, variantId, quantity, status: 'HELD' })),
    );
    return 'RESERVED';
  }

  command(orderId: string, command: ReservationCommand): CommandOutcome | LockBudgetExhausted {
    const status = this.headers.get(orderId)?.status;
    switch (command) {
      case 'commit':
        if (status === 'COMMITTED') return 'IDEMPOTENT';
        if (status !== 'HELD') return 'CONFLICT';
        return this.settle(orderId, 'COMMITTED', (level, quantity) => {
          level.onHand -= quantity;
          level.reserved -= quantity;
        });
      case 'release':
        if (status === undefined) {
          this.headers.set(orderId, { orderId, status: 'FENCED', holdUntil: null });
          return 'APPLIED';
        }
        if (status === 'RELEASED' || status === 'FENCED') return 'IDEMPOTENT';
        if (status !== 'HELD') return 'CONFLICT';
        return this.settle(orderId, 'RELEASED', (level, quantity) => {
          level.reserved -= quantity;
        });
      case 'restock':
        if (status === 'RESTOCKED') return 'IDEMPOTENT';
        if (status !== 'COMMITTED') return 'CONFLICT';
        return this.settle(orderId, 'RESTOCKED', (level, quantity) => {
          level.onHand += quantity;
        });
    }
  }

  statusOf(orderIds: string[]): Record<string, ReservationOrderStatus | null> {
    return Object.fromEntries(orderIds.map((orderId) => [orderId, this.headers.get(orderId)?.status ?? null]));
  }

  private settle(
    orderId: string,
    to: 'COMMITTED' | 'RELEASED' | 'RESTOCKED',
    move: (level: StubStockLevel, quantity: number) => void,
  ): CommandOutcome | LockBudgetExhausted {
    const holds = this.holds.get(orderId) ?? [];
    if (holds.some(({ variantId }) => this.locked.has(variantId))) return LOCK_BUDGET_EXHAUSTED;
    for (const hold of holds) {
      const level = this.stock.get(hold.variantId);
      if (level) move(level, hold.quantity);
      hold.status = to;
    }
    this.headers.set(orderId, { orderId, status: to, holdUntil: null });
    return 'APPLIED';
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
      if (fault.kind === 'status') return void reply(res, fault.status, { statusCode: fault.status });
      if (fault.kind === 'busy') return void replyBusy(res);
      fault.arrived();
      this.hanging.add(res);
      res.on('close', () => this.hanging.delete(res));
      return;
    }

    // The real controller's order: caller token guard, then the id pipe, then the body.
    if (req.headers.authorization !== `Bearer ${requiredEnv('INVENTORY_SERVICE_TOKEN')}`) {
      return void reply(res, 401, { statusCode: 401, message: 'Unauthorized' });
    }
    if (route.name !== 'status' && !isRoutableId(route.orderId)) return void badRequest(res);
    const body = parse(raw);

    if (route.name === 'status') {
      if (!isStatusBody(body)) return void badRequest(res);
      return void reply(res, 200, { statuses: this.statusOf(body.orderIds) });
    }
    if (route.name === 'try') {
      if (!isTryBody(body)) return void badRequest(res);
      const outcome = this.tryReserve(route.orderId, body.lines, new Date(body.holdUntil));
      if (outcome === LOCK_BUDGET_EXHAUSTED) return void replyBusy(res);
      return void reply(res, TRY_OUTCOME_STATUS[outcome], { outcome });
    }
    const outcome = this.command(route.orderId, route.name);
    if (outcome === LOCK_BUDGET_EXHAUSTED) return void replyBusy(res);
    reply(res, COMMAND_OUTCOME_STATUS[outcome], { outcome });
  }
}

type Route = { name: 'status' } | { name: 'try' | ReservationCommand; orderId: string };

function routeOf(path: string): Route | null {
  if (path === `/${RESERVATIONS_PREFIX}/status`) return { name: 'status' };
  const match = new RegExp(`^/${RESERVATIONS_PREFIX}/([^/]+)/([a-z]+)$`).exec(path);
  if (!match) return null;
  const name = match[2];
  if (name !== 'try' && !(RESERVATION_COMMANDS as readonly string[]).includes(name)) return null;
  return { name: name as 'try' | ReservationCommand, orderId: decodeURIComponent(match[1]) };
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

function isTryBody(body: unknown): body is { lines: ReservationLineBody[]; holdUntil: string } {
  if (!isRecord(body) || !Array.isArray(body.lines) || body.lines.length === 0) return false;
  if (typeof body.holdUntil !== 'string' || !(Date.parse(body.holdUntil) > Date.now())) return false;
  const lines = body.lines as unknown[];
  const valid = lines.every(
    (line) =>
      isRecord(line) &&
      isRoutableId(line.variantId) &&
      Number.isInteger(line.quantity) &&
      (line.quantity as number) >= 1,
  );
  return valid && new Set(lines.map((line) => (line as ReservationLineBody).variantId)).size === lines.length;
}

function badRequest(res: ServerResponse): void {
  reply(res, 400, { statusCode: 400, message: 'Bad Request' });
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function replyBusy(res: ServerResponse): void {
  const statusCode = LOCK_BUDGET_EXHAUSTED_STATUS;
  reply(
    res,
    statusCode,
    { statusCode, code: LOCK_BUDGET_EXHAUSTED, message: 'Service unavailable' },
    { 'retry-after': '1' },
  );
}

// Read per call, from the same env the app validates, so the stub can never trust a different value.
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set for the e2e run`);
  return value;
}

let started: Promise<InventoryServiceStub> | undefined;

export function inventoryServiceStub(): Promise<InventoryServiceStub> {
  started ??= InventoryServiceStub.start();
  return started;
}
