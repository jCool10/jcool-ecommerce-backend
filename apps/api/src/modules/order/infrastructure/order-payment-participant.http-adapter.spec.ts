import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClsService } from 'nestjs-cls';
import { PROVIDER_UNAVAILABLE } from '@jcool/internal-contracts';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { type FakeMetricsPort, fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentProviderUnavailableError } from '../application/ports/order-payment-participant.port';
import {
  OrderPaymentParticipantHttpAdapter,
  PAYMENT_SERVICE_BREAKER,
  PaymentServiceRejection,
  createPaymentServiceAdapter,
  isPaymentServiceFault,
} from './order-payment-participant.http-adapter';

interface Received {
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

type Reply = { status: number; body?: unknown; raw?: string; delayMs?: number } | 'hang';

const ORDER_ID = '137465797020397179';
const OTHER_ORDER_ID = '137465797020397180';
const PAYMENT_ID = '137465797020397181';
const TOKEN = 'api-to-payment-token-api-to-payment-token-00';
const EXPIRES_AT = new Date('2026-10-21T10:00:00.000Z');
const SESSION_INPUT = { orderId: ORDER_ID, amountMinor: 125_000, currency: 'VND', expiresAt: EXPIRES_AT };
const OPENED = {
  outcome: 'OPENED',
  paymentId: PAYMENT_ID,
  providerSessionId: 'cs_test_1',
  redirectUrl: 'https://checkout.stripe.test/cs_test_1',
  clientSecret: 'cs_test_1_secret',
};
const AUTHORIZED = {
  header: 'AUTHORIZED',
  authorizedPaymentId: PAYMENT_ID,
  hasAuthorizedAttempt: true,
  hasSucceededAttempt: false,
};
const NEVER_SEEN = { header: null, authorizedPaymentId: null, hasAuthorizedAttempt: false, hasSucceededAttempt: false };
const STRIPE_AWAY: Reply = {
  status: 503,
  body: { statusCode: 503, code: PROVIDER_UNAVAILABLE, message: 'Service unavailable' },
};

class FakePaymentService {
  readonly received: Received[] = [];
  reply: (request: Received) => Reply = () => ({ status: 200, body: { outcome: 'CAPTURED' } });
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

describe('OrderPaymentParticipantHttpAdapter', () => {
  let payment: FakePaymentService;
  let url: string;
  const adapter = ({ commandTimeoutMs = 1_000, breaker = passThrough, baseUrl = url } = {}) =>
    new OrderPaymentParticipantHttpAdapter({ url: baseUrl, token: TOKEN, commandTimeoutMs }, breaker, inRequest());

  beforeEach(async () => {
    payment = new FakePaymentService();
    url = await payment.start();
  });

  afterEach(() => payment.stop());

  it('opens a session with the charge, the deadline, the caller token and the request id', async () => {
    payment.reply = () => ({ status: 200, body: OPENED });

    await expect(adapter().openSession(SESSION_INPUT)).resolves.toEqual(OPENED);

    const [request] = payment.received;
    expect(request.url).toBe(`/internal/v1/payments/${ORDER_ID}/session`);
    expect(request.body).toEqual({ amountMinor: 125_000, currency: 'VND', expiresAt: EXPIRES_AT.toISOString() });
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers['x-request-id']).toBe('req-uuid');
  });

  it('reads a closed session as CLOSED', async () => {
    payment.reply = () => ({ status: 409, body: { outcome: 'CLOSED' } });

    await expect(adapter().openSession(SESSION_INPUT)).resolves.toEqual({ outcome: 'CLOSED' });
  });

  it.each<[string, Reply]>([
    ['an OPENED with no paymentId', { status: 200, body: { ...OPENED, paymentId: undefined } }],
    ['a 503', { status: 503 }],
    ['a 503 for Stripe being away', STRIPE_AWAY],
    ['a 400', { status: 400 }],
    ['a body that is not JSON', { status: 200, raw: 'OPENED' }],
  ])('tells /pay the provider is unavailable on %s', async (_case, reply) => {
    payment.reply = () => reply;

    const error = await adapter()
      .openSession(SESSION_INPUT)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentProviderUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(PaymentServiceRejection);
  });

  it('tells /pay the provider is unavailable when the service never answers', async () => {
    payment.reply = () => 'hang';

    await expect(adapter({ commandTimeoutMs: 100 }).openSession(SESSION_INPUT)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it.each([
    ['capture', 200, 'CAPTURED'],
    ['capture', 200, 'IDEMPOTENT'],
    ['capture', 409, 'NOT_CAPTURABLE'],
    ['capture', 409, 'CONFLICT'],
    ['cancel', 200, 'CANCELLED'],
    ['cancel', 200, 'FENCED'],
    ['cancel', 200, 'IDEMPOTENT'],
    ['cancel', 409, 'CAPTURED_CONFLICT'],
  ] as const)('posts %s for the order and reads %d %s', async (command, status, outcome) => {
    payment.reply = () => ({ status, body: { outcome } });

    await expect(adapter()[command](ORDER_ID)).resolves.toBe(outcome);
    expect(payment.received[0].url).toBe(`/internal/v1/payments/${ORDER_ID}/${command}`);
    expect(payment.received[0].body).toBeUndefined();
  });

  it('reads a status per order, with the attempt that holds the money', async () => {
    payment.reply = () => ({
      status: 200,
      body: { statuses: { [ORDER_ID]: AUTHORIZED, [OTHER_ORDER_ID]: NEVER_SEEN } },
    });

    const statuses = await adapter().statusOf([ORDER_ID, OTHER_ORDER_ID]);

    expect(statuses).toEqual(
      new Map<string, unknown>([
        [ORDER_ID, AUTHORIZED],
        [OTHER_ORDER_ID, NEVER_SEEN],
      ]),
    );
    expect(payment.received[0].url).toBe('/internal/v1/payments/status');
    expect(payment.received[0].body).toEqual({ orderIds: [ORDER_ID, OTHER_ORDER_ID] });
  });

  it('answers an empty batch without asking the service, which refuses one', async () => {
    await expect(adapter().statusOf([])).resolves.toEqual(new Map());
    expect(payment.received).toHaveLength(0);
  });

  it.each<[string, Reply]>([
    [
      'an entry with no authorizedPaymentId',
      { status: 200, body: { statuses: { [ORDER_ID]: { ...AUTHORIZED, authorizedPaymentId: undefined } } } },
    ],
    ['an answer that leaves out an id asked for', { status: 200, body: { statuses: {} } }],
    ['a 503', { status: 503 }],
  ])('throws on a status with %s rather than answering an empty map', async (_case, reply) => {
    payment.reply = () => reply;

    await expect(adapter().statusOf([ORDER_ID])).rejects.toBeInstanceOf(PaymentServiceRejection);
  });

  it.each<[string, Reply]>([
    ['a 503', { status: 503 }],
    ['a 503 for Stripe being away', STRIPE_AWAY],
    ['a 500', { status: 500 }],
    ['a 429', { status: 429 }],
    ['a 401', { status: 401 }],
    ['a 409 with no outcome', { status: 409, body: { message: 'Conflict' } }],
    ['an outcome the status code disagrees with', { status: 200, body: { outcome: 'NOT_CAPTURABLE' } }],
    ['an outcome the contract does not name', { status: 200, body: { outcome: 'DONE' } }],
    ['a body that is not JSON', { status: 200, raw: 'CAPTURED' }],
  ])('throws on %s for the activity to retry', async (_case, reply) => {
    payment.reply = () => reply;

    await expect(adapter().capture(ORDER_ID)).rejects.toBeInstanceOf(PaymentServiceRejection);
  });

  it('throws when the service does not answer at all', async () => {
    await expect(adapter({ baseUrl: 'http://127.0.0.1:1' }).capture(ORDER_ID)).rejects.toThrow();
  });

  it.each<[string, Reply, string | undefined]>([
    ['a 503 coded for Stripe being away', STRIPE_AWAY, PROVIDER_UNAVAILABLE],
    ['a bare 503', { status: 503 }, undefined],
    ['a 500 that borrows the code', { status: 500, body: { code: PROVIDER_UNAVAILABLE } }, undefined],
  ])('keeps the provider code from %s only where the contract puts it', async (_case, reply, code) => {
    payment.reply = () => reply;

    const error = await adapter()
      .capture(ORDER_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentServiceRejection);
    expect((error as PaymentServiceRejection).code).toBe(code);
  });

  it.each<[string, unknown, boolean]>([
    ['a 400', new PaymentServiceRejection(400, '/x'), false],
    ['a 401', new PaymentServiceRejection(401, '/x'), false],
    ['a 409 with no outcome', new PaymentServiceRejection(409, '/x'), false],
    ['a 429', new PaymentServiceRejection(429, '/x'), false],
    ['a 503 for Stripe being away', new PaymentServiceRejection(503, '/x', PROVIDER_UNAVAILABLE), false],
    ['a 500', new PaymentServiceRejection(500, '/x'), true],
    ['a 503', new PaymentServiceRejection(503, '/x'), true],
    ['a refused connection', new TypeError('fetch failed'), true],
    ['a deadline', new DOMException('The operation timed out.', 'TimeoutError'), true],
  ])('tells the breaker whether %s is a fault of the service', (_case, error, fault) => {
    expect(isPaymentServiceFault(error)).toBe(fault);
  });

  it('drops a command the moment its caller gives up', async () => {
    payment.reply = () => 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const captured = await elapsed(() =>
      adapter({ commandTimeoutMs: 5_000 }).capture(ORDER_ID, { signal: controller.signal }),
    );

    expect(captured).toBeLessThan(1_000);
  });

  describe('behind the breaker', () => {
    const guarded = () =>
      adapter({
        commandTimeoutMs: 100,
        breaker: breakerFactory().create(PAYMENT_SERVICE_BREAKER, { isDownstreamFault: isPaymentServiceFault }),
      });

    it('keeps the circuit closed through refusals, throttling and answers about the request', async () => {
      const target = guarded();
      for (const reply of [
        { status: 409, body: { outcome: 'NOT_CAPTURABLE' } },
        { status: 409, body: {} },
        { status: 429 },
        { status: 400 },
      ]) {
        payment.reply = () => reply;
        for (let i = 0; i < 4; i++) await target.capture(ORDER_ID).catch(() => undefined);
      }

      payment.reply = () => ({ status: 200, body: { outcome: 'CAPTURED' } });
      await expect(target.capture(ORDER_ID)).resolves.toBe('CAPTURED');
    });

    // Alone, so the outage is every call in the window: a 503 counted as a fault would open the circuit.
    it('keeps the circuit closed while Stripe is away, so status reads and cancels still get through', async () => {
      const target = guarded();
      payment.reply = () => STRIPE_AWAY;
      for (let i = 0; i < 2; i++) {
        await target.capture(ORDER_ID).catch(() => undefined);
        await target.openSession(SESSION_INPUT).catch(() => undefined);
      }

      payment.reply = () => ({ status: 200, body: { outcome: 'CANCELLED' } });
      await expect(target.cancel(ORDER_ID)).resolves.toBe('CANCELLED');
    });

    it.each<[string, Reply]>([
      ['server errors', { status: 503 }],
      ['timeouts', 'hang'],
    ])('opens on %s, then refuses without calling', async (_case, reply) => {
      const target = guarded();
      payment.reply = () => reply;
      for (let i = 0; i < 4; i++) await target.capture(ORDER_ID).catch(() => undefined);
      const reached = payment.received.length;

      await expect(target.capture(ORDER_ID)).rejects.toBeInstanceOf(DownstreamUnavailableError);
      expect(payment.received).toHaveLength(reached);
    });
  });

  // A capture may chain several Stripe calls; the shared breaker timeout must not cut it short.
  it(
    'waits a slow capture out to the command deadline, past the shared breaker timeout',
    { timeout: 10_000 },
    async () => {
      const metrics = fakeMetricsPort();
      const config = fakeConfigService({
        'paymentService.url': url,
        'paymentService.token': TOKEN,
        'paymentService.commandTimeoutMs': 5_000,
      });
      payment.reply = () => ({ status: 200, body: { outcome: 'CAPTURED' }, delayMs: 3_500 });

      const target = createPaymentServiceAdapter(config, breakerFactory(metrics, 3_000), inRequest());

      await expect(target.capture(ORDER_ID)).resolves.toBe('CAPTURED');
      expect(metrics.recordBreakerCall).toHaveBeenCalledWith(PAYMENT_SERVICE_BREAKER, 'success');
    },
  );

  it('sizes the breaker a second above the command deadline', () => {
    const breakers = breakerFactory();
    const create = vi.spyOn(breakers, 'create');
    const config = fakeConfigService({
      'paymentService.url': url,
      'paymentService.token': TOKEN,
      'paymentService.commandTimeoutMs': 45_000,
    });

    createPaymentServiceAdapter(config, breakers, inRequest());

    expect(create).toHaveBeenCalledWith(PAYMENT_SERVICE_BREAKER, expect.objectContaining({ timeoutMs: 46_000 }));
  });
});
