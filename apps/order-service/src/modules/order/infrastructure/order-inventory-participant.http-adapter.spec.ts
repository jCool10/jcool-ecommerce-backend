import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClsService } from 'nestjs-cls';
import { LOCK_BUDGET_EXHAUSTED } from '@jcool/internal-contracts';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { type FakeMetricsPort, fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  INVENTORY_SERVICE_BREAKER,
  InventoryServiceRejection,
  OrderInventoryParticipantHttpAdapter,
  createInventoryServiceAdapter,
  isInventoryServiceFault,
} from './order-inventory-participant.http-adapter';

interface Received {
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

// `stall` sends the headers and part of a body, then nothing more.
type Reply = { status: number; body?: unknown; raw?: string; delayMs?: number } | 'hang' | 'stall';

const ORDER_ID = '137465797020397179';
const SKU_ID = '137465797020397180';
const BUSY_ROWS: Reply = {
  status: 503,
  body: { statusCode: 503, code: LOCK_BUDGET_EXHAUSTED, message: 'Service unavailable' },
};
const TOKEN = 'api-to-inventory-token-api-to-inventory-token';
const HOLD_UNTIL = new Date('2026-10-21T10:00:00.000Z');

class FakeInventoryService {
  readonly received: Received[] = [];
  reply: (request: Received) => Reply = () => ({ status: 200, body: { outcome: 'APPLIED' } });
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const request = { url: req.url, headers: req.headers, body: raw ? (JSON.parse(raw) as unknown) : undefined };
        this.received.push(request);
        const reply = this.reply(request);
        if (reply === 'hang') return;
        if (reply === 'stall') {
          res.writeHead(200, { 'content-type': 'application/json' }).write('{"outcome":');
          return;
        }
        const send = () =>
          res
            .writeHead(reply.status, { 'content-type': 'application/json' })
            .end(reply.raw ?? JSON.stringify(reply.body ?? {}));
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const passThrough: OutboundCall = { run: (task) => task() };
const inRequest = (id = 'req-uuid'): ClsService => ({ isActive: () => true, getId: () => id }) as unknown as ClsService;

function breakerFactory(metrics: FakeMetricsPort = fakeMetricsPort(), timeoutMs = 3_000): CircuitBreakerFactory {
  const config = fakeConfigService({
    'resilience.breaker.enabled': true,
    'resilience.breaker.timeoutMs': timeoutMs,
    'resilience.breaker.errorThresholdPercentage': 50,
    'resilience.breaker.resetTimeoutMs': 60_000,
    'resilience.breaker.rollingWindowMs': 10_000,
    'resilience.breaker.volumeThreshold': 2,
  });
  const cls = { exit: <T>(run: () => T): T => run() } as unknown as ClsService;
  return new CircuitBreakerFactory(config, metrics, fakePinoLogger(), cls);
}

const elapsed = async (run: () => Promise<unknown>): Promise<number> => {
  const started = Date.now();
  await run().catch(() => undefined);
  return Date.now() - started;
};

describe('OrderInventoryParticipantHttpAdapter', () => {
  let inventory: FakeInventoryService;
  let url: string;
  const adapter = ({ tryTimeoutMs = 1_000, commandTimeoutMs = 1_000, breaker = passThrough, baseUrl = url } = {}) =>
    new OrderInventoryParticipantHttpAdapter(
      { url: baseUrl, token: TOKEN, tryTimeoutMs, commandTimeoutMs },
      breaker,
      inRequest(),
    );
  const tryReserve = (target = adapter(), signal?: AbortSignal) =>
    target.tryReserve(
      { orderId: ORDER_ID, lines: [{ skuId: SKU_ID, quantity: 2 }], holdUntil: HOLD_UNTIL },
      { signal },
    );

  beforeEach(async () => {
    inventory = new FakeInventoryService();
    url = await inventory.start();
  });

  afterEach(() => inventory.stop());

  it('sends the Try with variant ids, the hold deadline, the caller token and the request id', async () => {
    inventory.reply = () => ({ status: 201, body: { outcome: 'RESERVED' } });

    await expect(tryReserve()).resolves.toBe('RESERVED');

    const [request] = inventory.received;
    expect(request.url).toBe(`/internal/v1/reservations/${ORDER_ID}/try`);
    expect(request.body).toEqual({ lines: [{ variantId: SKU_ID, quantity: 2 }], holdUntil: HOLD_UNTIL.toISOString() });
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers['x-request-id']).toBe('req-uuid');
  });

  it.each([
    [201, 'RESERVED'],
    [409, 'OUT_OF_STOCK'],
    [409, 'CONTENDED'],
    [409, 'CONFLICT'],
  ] as const)('reads a Try answered %d %s as that outcome', async (status, outcome) => {
    inventory.reply = () => ({ status, body: { outcome } });

    await expect(tryReserve()).resolves.toBe(outcome);
  });

  it.each([
    ['commit', 200, 'APPLIED'],
    ['release', 200, 'IDEMPOTENT'],
    ['restock', 409, 'CONFLICT'],
  ] as const)('posts %s for the order and reads %d %s', async (command, status, outcome) => {
    inventory.reply = () => ({ status, body: { outcome } });

    await expect(adapter()[command](ORDER_ID)).resolves.toBe(outcome);
    expect(inventory.received[0].url).toBe(`/internal/v1/reservations/${ORDER_ID}/${command}`);
  });

  it('reads a status for every id asked for', async () => {
    inventory.reply = () => ({ status: 200, body: { statuses: { [ORDER_ID]: 'HELD', [SKU_ID]: null } } });

    const statuses = await adapter().statusOf([ORDER_ID, SKU_ID]);

    expect(statuses).toEqual(
      new Map([
        [ORDER_ID, 'HELD'],
        [SKU_ID, null],
      ]),
    );
    expect(inventory.received[0].body).toEqual({ orderIds: [ORDER_ID, SKU_ID] });
  });

  it('answers an empty batch without asking the service, which refuses one', async () => {
    await expect(adapter().statusOf([])).resolves.toEqual(new Map());
    expect(inventory.received).toHaveLength(0);
  });

  it.each<[string, Reply]>([
    ['a 503', { status: 503 }],
    ['a 503 for busy rows', BUSY_ROWS],
    ['a 500', { status: 500 }],
    ['a 429', { status: 429 }],
    ['a 401', { status: 401 }],
    ['a 409 with no outcome', { status: 409, body: { message: 'Conflict' } }],
    ['an outcome the status code disagrees with', { status: 200, body: { outcome: 'CONFLICT' } }],
    ['an outcome the contract does not name', { status: 200, body: { outcome: 'DONE' } }],
    ['a body that is not JSON', { status: 200, raw: 'APPLIED' }],
  ])('throws on %s for the activity to retry', async (_case, reply) => {
    inventory.reply = () => reply;

    await expect(adapter().commit(ORDER_ID)).rejects.toBeInstanceOf(InventoryServiceRejection);
  });

  it('counts a body cut off by the deadline as no answer, not as an answer it could not read', async () => {
    inventory.reply = () => 'stall';

    const error = await adapter({ commandTimeoutMs: 200 })
      .commit(ORDER_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(InventoryServiceRejection);
    expect(isInventoryServiceFault(error)).toBe(true);
  });

  it.each<[string, Reply, string | undefined]>([
    ['a 503 coded for busy rows', BUSY_ROWS, LOCK_BUDGET_EXHAUSTED],
    ['a bare 503', { status: 503 }, undefined],
    ['a 500 that borrows the code', { status: 500, body: { code: LOCK_BUDGET_EXHAUSTED } }, undefined],
  ])('keeps the busy-rows code from %s only where the contract puts it', async (_case, reply, code) => {
    inventory.reply = () => reply;

    const error = await adapter()
      .commit(ORDER_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InventoryServiceRejection);
    expect((error as InventoryServiceRejection).code).toBe(code);
  });

  it.each<[string, unknown, boolean]>([
    ['a 400', new InventoryServiceRejection(400, '/x'), false],
    ['a 401', new InventoryServiceRejection(401, '/x'), false],
    ['a 409 with no outcome', new InventoryServiceRejection(409, '/x'), false],
    ['a 429', new InventoryServiceRejection(429, '/x'), false],
    ['a 503 for busy rows', new InventoryServiceRejection(503, '/x', LOCK_BUDGET_EXHAUSTED), false],
    ['a 500', new InventoryServiceRejection(500, '/x'), true],
    ['a 503', new InventoryServiceRejection(503, '/x'), true],
    ['a refused connection', new TypeError('fetch failed'), true],
    ['a deadline', new DOMException('The operation timed out.', 'TimeoutError'), true],
  ])('tells the breaker whether %s is a fault of the service', (_case, error, fault) => {
    expect(isInventoryServiceFault(error)).toBe(fault);
  });

  it('throws on a status answer that leaves out an id asked for', async () => {
    inventory.reply = () => ({ status: 200, body: { statuses: { [ORDER_ID]: 'HELD' } } });

    await expect(adapter().statusOf([ORDER_ID, SKU_ID])).rejects.toBeInstanceOf(InventoryServiceRejection);
  });

  it('throws when the service does not answer at all', async () => {
    await expect(adapter({ baseUrl: 'http://127.0.0.1:1' }).commit(ORDER_ID)).rejects.toThrow();
  });

  it('gives the Try its own deadline and every command the command deadline', async () => {
    inventory.reply = () => 'hang';
    const target = adapter({ tryTimeoutMs: 100, commandTimeoutMs: 400 });

    const tried = await elapsed(() => tryReserve(target));
    const committed = await elapsed(() => target.commit(ORDER_ID));
    const asked = await elapsed(() => target.statusOf([ORDER_ID]));

    expect(tried).toBeLessThan(300);
    expect(committed).toBeGreaterThanOrEqual(350);
    expect(asked).toBeGreaterThanOrEqual(350);
  });

  it('drops a Try the moment its caller gives up', async () => {
    inventory.reply = () => 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const tried = await elapsed(() => tryReserve(adapter({ tryTimeoutMs: 5_000 }), controller.signal));

    expect(tried).toBeLessThan(1_000);
  });

  describe('behind the breaker', () => {
    const guarded = () =>
      adapter({
        breaker: breakerFactory().create(INVENTORY_SERVICE_BREAKER, { isDownstreamFault: isInventoryServiceFault }),
      });

    // Alone, so the burst is every call in the window: a 503 counted as a fault would open the circuit.
    it('keeps the circuit closed through a burst of busy rows on one hot SKU', async () => {
      const target = guarded();
      inventory.reply = () => BUSY_ROWS;
      for (let i = 0; i < 4; i++) await target.commit(ORDER_ID).catch(() => undefined);

      inventory.reply = () => ({ status: 200, body: { outcome: 'APPLIED' } });
      await expect(target.commit(ORDER_ID)).resolves.toBe('APPLIED');
    });

    it('keeps the circuit closed through refusals, throttling and answers about the request', async () => {
      const target = guarded();
      for (const reply of [
        { status: 409, body: { outcome: 'CONFLICT' } },
        { status: 409, body: {} },
        { status: 429 },
        { status: 400 },
      ]) {
        inventory.reply = () => reply;
        for (let i = 0; i < 4; i++) await target.commit(ORDER_ID).catch(() => undefined);
      }

      inventory.reply = () => ({ status: 200, body: { outcome: 'APPLIED' } });
      await expect(target.commit(ORDER_ID)).resolves.toBe('APPLIED');
    });

    it.each<[string, Reply]>([
      ['server errors', { status: 503 }],
      ['timeouts', 'hang'],
    ])('opens on %s, then refuses without calling', async (_case, reply) => {
      const target = adapter({
        commandTimeoutMs: 100,
        breaker: breakerFactory().create(INVENTORY_SERVICE_BREAKER, { isDownstreamFault: isInventoryServiceFault }),
      });
      inventory.reply = () => reply;
      for (let i = 0; i < 4; i++) await target.commit(ORDER_ID).catch(() => undefined);
      const reached = inventory.received.length;

      await expect(target.commit(ORDER_ID)).rejects.toBeInstanceOf(DownstreamUnavailableError);
      expect(inventory.received).toHaveLength(reached);
    });
  });

  // The shared breaker timeout is shorter than a command's own deadline; the adapter's wins.
  it('waits a slow command out to its own deadline, past the shared breaker timeout', { timeout: 10_000 }, async () => {
    const metrics = fakeMetricsPort();
    const config = fakeConfigService({
      'inventoryService.url': url,
      'inventoryService.token': TOKEN,
      'inventoryService.commandTimeoutMs': 5_000,
      'checkoutSaga.tryTimeoutMs': 3_000,
    });
    inventory.reply = () => ({ status: 200, body: { outcome: 'APPLIED' }, delayMs: 3_500 });

    const target = createInventoryServiceAdapter(config, breakerFactory(metrics, 3_000), inRequest());

    await expect(target.commit(ORDER_ID)).resolves.toBe('APPLIED');
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(INVENTORY_SERVICE_BREAKER, 'success');
  });

  it('sizes the breaker above the longer of the Try and command deadlines', () => {
    const breakers = breakerFactory();
    const create = vi.spyOn(breakers, 'create');
    const config = fakeConfigService({
      'inventoryService.url': url,
      'inventoryService.token': TOKEN,
      'inventoryService.commandTimeoutMs': 5_000,
      'checkoutSaga.tryTimeoutMs': 3_000,
    });

    createInventoryServiceAdapter(config, breakers, inRequest());

    expect(create).toHaveBeenCalledWith(INVENTORY_SERVICE_BREAKER, expect.objectContaining({ timeoutMs: 6_000 }));
  });
});
