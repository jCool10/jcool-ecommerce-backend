import type { Mock } from 'vitest';
import { DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { CheckoutReadUnavailableError } from '../application/checkout-unavailable.error';
import {
  API_INTERNAL_BREAKER,
  ApiInternalClient,
  ApiInternalRejection,
  createApiInternalClient,
  isApiInternalFault,
} from './api-internal.http-client';
import { CartSnapshotHttpAdapter } from './cart-snapshot.http-adapter';
import { type ApiReply, FakeApiService, eagerBreakerFactory, inRequest } from './testing/fake-api-service';

const USER_ID = '137465797020397179';
const SKU_A = '137465797020397180';
const SKU_B = '137465797020397181';
const TOKEN = 'order-to-api-token-order-to-api-token-000';
const LINES = [
  { skuId: SKU_A, quantity: 2 },
  { skuId: SKU_B, quantity: 1 },
];

const passThrough: OutboundCall = { run: (task) => task() };

describe('CartSnapshotHttpAdapter', () => {
  let api: FakeApiService;
  let url: string;
  let error: Mock;
  const adapter = ({ timeoutMs = 1_000, breaker = passThrough, baseUrl = url } = {}) =>
    new CartSnapshotHttpAdapter(
      new ApiInternalClient({ url: baseUrl, token: TOKEN, timeoutMs }, breaker, inRequest(), fakePinoLogger({ error })),
    );
  const failureOf = (run: Promise<unknown>) => run.then(() => undefined).catch((thrown: unknown) => thrown);

  beforeEach(async () => {
    error = vi.fn();
    api = new FakeApiService();
    url = await api.start();
  });

  afterEach(() => api.stop());

  it('reads the lines in cart order, with the caller token and the request id', async () => {
    api.reply = () => ({ status: 200, body: { lines: LINES } });

    await expect(adapter().getLines(USER_ID)).resolves.toEqual(LINES);

    const [request] = api.received;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`/internal/v1/carts/${USER_ID}/lines`);
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers['x-request-id']).toBe('req-uuid');
  });

  it('reads a user with no cart as no lines', async () => {
    api.reply = () => ({ status: 200, body: { lines: [] } });

    await expect(adapter().getLines(USER_ID)).resolves.toEqual([]);
  });

  it('keeps only the fields the contract names', async () => {
    api.reply = () => ({ status: 200, body: { lines: [{ ...LINES[0], priceMinor: 100 }], cartId: '1' } });

    await expect(adapter().getLines(USER_ID)).resolves.toStrictEqual([LINES[0]]);
  });

  // Each of these means this service is pointed at the wrong place or holds the wrong token.
  it.each([404, 400, 401, 403])(
    'fails the read on a %d, never reading it as an empty cart, and logs it',
    async (status) => {
      api.reply = () => ({ status, body: { lines: [] } });

      const thrown = await failureOf(adapter().getLines(USER_ID));

      expect(thrown).toBeInstanceOf(CheckoutReadUnavailableError);
      expect((thrown as Error).cause).toEqual(new ApiInternalRejection(status, `/internal/v1/carts/${USER_ID}/lines`));
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status, path: `/internal/v1/carts/${USER_ID}/lines` }),
        'api-internal answered off its contract',
      );
    },
  );

  it.each<[string, ApiReply]>([
    ['a line with no quantity', { status: 200, body: { lines: [{ skuId: SKU_A }] } }],
    ['a zero quantity', { status: 200, body: { lines: [{ skuId: SKU_A, quantity: 0 }] } }],
    ['no lines field', { status: 200, body: { items: LINES } }],
    ['a body that is not JSON', { status: 200, raw: 'lines' }],
  ])('fails the read on %s and logs it', async (_case, reply) => {
    api.reply = () => reply;

    await expect(adapter().getLines(USER_ID)).rejects.toBeInstanceOf(CheckoutReadUnavailableError);
    expect(error).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 503])('fails the read on a %d without an error log', async (status) => {
    api.reply = () => ({ status });

    await expect(adapter().getLines(USER_ID)).rejects.toBeInstanceOf(CheckoutReadUnavailableError);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails the read at its deadline when the api never answers', async () => {
    api.reply = () => 'hang';
    const started = Date.now();

    await expect(adapter({ timeoutMs: 100 }).getLines(USER_ID)).rejects.toBeInstanceOf(CheckoutReadUnavailableError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails the read when nothing listens at the address', async () => {
    await expect(adapter({ baseUrl: 'http://127.0.0.1:1' }).getLines(USER_ID)).rejects.toBeInstanceOf(
      CheckoutReadUnavailableError,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, boolean]>([
    ['a 400', new ApiInternalRejection(400, '/x'), false],
    ['a 401', new ApiInternalRejection(401, '/x'), false],
    ['a 404', new ApiInternalRejection(404, '/x'), false],
    ['a 429', new ApiInternalRejection(429, '/x'), false],
    ['a 200 off the contract', new ApiInternalRejection(200, '/x'), false],
    ['a 500', new ApiInternalRejection(500, '/x'), true],
    ['a 503', new ApiInternalRejection(503, '/x'), true],
    ['a refused connection', new TypeError('fetch failed'), true],
    ['a deadline', new DOMException('The operation timed out.', 'TimeoutError'), true],
  ])('tells the breaker whether %s is a fault of the api', (_case, thrown, fault) => {
    expect(isApiInternalFault(thrown)).toBe(fault);
  });

  describe('behind the breaker', () => {
    const guarded = () =>
      adapter({
        timeoutMs: 100,
        breaker: eagerBreakerFactory().create(API_INTERNAL_BREAKER, { isDownstreamFault: isApiInternalFault }),
      });

    it('keeps the circuit closed through refusals, throttling and bodies off the contract', async () => {
      const target = guarded();
      for (const reply of [{ status: 404 }, { status: 401 }, { status: 429 }, { status: 200, raw: 'x' }]) {
        api.reply = () => reply;
        for (let i = 0; i < 4; i++) await target.getLines(USER_ID).catch(() => undefined);
      }

      api.reply = () => ({ status: 200, body: { lines: LINES } });
      await expect(target.getLines(USER_ID)).resolves.toEqual(LINES);
    });

    it.each<[string, ApiReply]>([
      ['server errors', { status: 503 }],
      ['timeouts', 'hang'],
    ])('opens on %s, then fails reads without calling', async (_case, reply) => {
      const target = guarded();
      api.reply = () => reply;
      for (let i = 0; i < 4; i++) await target.getLines(USER_ID).catch(() => undefined);
      const reached = api.received.length;

      const thrown = await failureOf(target.getLines(USER_ID));

      expect(thrown).toBeInstanceOf(CheckoutReadUnavailableError);
      expect((thrown as Error).cause).toBeInstanceOf(DownstreamUnavailableError);
      expect(api.received).toHaveLength(reached);
    });
  });

  it('gives its breaker the read deadline plus a second, not the shared timeout', () => {
    const breakers = eagerBreakerFactory();
    const create = vi.spyOn(breakers, 'create');

    createApiInternalClient(
      fakeConfigService({ 'apiService.url': url, 'apiService.token': TOKEN, 'apiService.timeoutMs': 2_000 }),
      breakers,
      inRequest(),
      fakePinoLogger(),
    );

    expect(create).toHaveBeenCalledExactlyOnceWith(API_INTERNAL_BREAKER, {
      timeoutMs: 3_000,
      isDownstreamFault: isApiInternalFault,
    });
  });
});
