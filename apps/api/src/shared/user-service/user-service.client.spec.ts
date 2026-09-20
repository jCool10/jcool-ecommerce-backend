import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClsService } from 'nestjs-cls';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  USER_SERVICE_BREAKER,
  UserServiceClient,
  UserServiceRejection,
  createUserServiceClient,
  isUserServiceFault,
} from './user-service.client';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

type Reply = { status: number; body: unknown } | 'hang';

const USER_ID = '0199a3b2-7c4d-8e5f-9a0b-1c2d3e4f5a6b';
const TOKEN = 'internal-token-internal-token-internal';
const SUMMARY = { id: USER_ID, email: 'buyer@example.com', role: 'CUSTOMER' };

class FakeUserService {
  readonly received: Received[] = [];
  reply: (request: Received) => Reply = () => ({ status: 200, body: SUMMARY });
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const request = { method: req.method, url: req.url, headers: req.headers };
      this.received.push(request);
      const reply = this.reply(request);
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
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

function breakerFactory(): CircuitBreakerFactory {
  const config = fakeConfigService({
    'resilience.breaker.enabled': true,
    'resilience.breaker.timeoutMs': 1_000,
    'resilience.breaker.errorThresholdPercentage': 50,
    'resilience.breaker.resetTimeoutMs': 60_000,
    'resilience.breaker.rollingWindowMs': 10_000,
    'resilience.breaker.volumeThreshold': 2,
  });
  const cls = { exit: <T>(run: () => T): T => run() } as unknown as ClsService;
  return new CircuitBreakerFactory(config, fakeMetricsPort(), fakePinoLogger(), cls);
}

describe('UserServiceClient', () => {
  let userService: FakeUserService;
  let url: string;
  const client = (timeoutMs = 1_000, breaker = passThrough) =>
    new UserServiceClient({ url, token: TOKEN, timeoutMs }, breaker);

  beforeEach(async () => {
    userService = new FakeUserService();
    url = await userService.start();
  });

  afterEach(() => userService.stop());

  it("reads a user's summary with the service token", async () => {
    await expect(client().userSummary(USER_ID)).resolves.toEqual(SUMMARY);
    expect(userService.received).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: `/internal/v1/users/${USER_ID}/summary`,
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) as IncomingHttpHeaders,
      }),
    ]);
  });

  it("reads a user's session epoch", async () => {
    userService.reply = () => ({ status: 200, body: { epoch: 3 } });

    await expect(client().sessionEpoch(USER_ID)).resolves.toBe(3);
    expect(userService.received[0].url).toBe(`/internal/v1/sessions/${USER_ID}/epoch`);
  });

  it.each([
    ['summary', (c: UserServiceClient) => c.userSummary(USER_ID)],
    ['epoch', (c: UserServiceClient) => c.sessionEpoch(USER_ID)],
  ])('answers null for the %s of a user the service does not have', async (_case, call) => {
    userService.reply = () => ({ status: 404, body: { statusCode: 404 } });

    await expect(call(client())).resolves.toBeNull();
  });

  it('keeps an id inside its path segment', async () => {
    await client().userSummary('a/../b');

    expect(userService.received[0].url).toBe('/internal/v1/users/a%2F..%2Fb/summary');
  });

  it.each<[string, Reply]>([
    ['a server error', { status: 503, body: {} }],
    ['a refused token', { status: 401, body: {} }],
    ['a summary without an email', { status: 200, body: { id: USER_ID, role: 'CUSTOMER' } }],
    ['a body that is not JSON', { status: 200, body: undefined }],
  ])('rejects %s', async (_case, reply) => {
    userService.reply = () => reply;

    await expect(client().userSummary(USER_ID)).rejects.toBeInstanceOf(UserServiceRejection);
  });

  it('reads a summary whose role it does not know', async () => {
    userService.reply = () => ({ status: 200, body: { ...SUMMARY, role: 'SUPPORT' } });

    await expect(client().userSummary(USER_ID)).resolves.toMatchObject({ email: SUMMARY.email });
  });

  it('rejects an epoch that is not a whole number', async () => {
    userService.reply = () => ({ status: 200, body: { epoch: '3' } });

    await expect(client().sessionEpoch(USER_ID)).rejects.toBeInstanceOf(UserServiceRejection);
  });

  it('gives up once the timeout runs out', async () => {
    userService.reply = () => 'hang';

    await expect(client(100).userSummary(USER_ID)).rejects.toThrow();
  });

  it('rejects when nothing is listening', async () => {
    url = 'http://127.0.0.1:1';

    await expect(client().userSummary(USER_ID)).rejects.toThrow();
  });

  describe('behind the breaker', () => {
    const behindBreaker = () =>
      client(1_000, breakerFactory().create(USER_SERVICE_BREAKER, { isDownstreamFault: isUserServiceFault }));

    it('keeps the circuit closed through answers about the request', async () => {
      const guarded = behindBreaker();
      userService.reply = () => ({ status: 401, body: {} });
      for (let i = 0; i < 5; i++) await guarded.userSummary(USER_ID).catch(() => undefined);
      userService.reply = () => ({ status: 404, body: {} });
      for (let i = 0; i < 5; i++) await guarded.userSummary(USER_ID);

      userService.reply = () => ({ status: 200, body: SUMMARY });
      await expect(guarded.userSummary(USER_ID)).resolves.toEqual(SUMMARY);
    });

    it('opens the circuit on server errors and stops calling', async () => {
      const guarded = behindBreaker();
      userService.reply = () => ({ status: 500, body: {} });
      for (let i = 0; i < 5; i++) await guarded.userSummary(USER_ID).catch(() => undefined);
      const reached = userService.received.length;

      await expect(guarded.userSummary(USER_ID)).rejects.toBeInstanceOf(DownstreamUnavailableError);
      expect(userService.received).toHaveLength(reached);
    });
  });

  describe('createUserServiceClient', () => {
    it('refuses to build without the internal URL', () => {
      const config = fakeConfigService({
        'userService.internalApiToken': TOKEN,
        'userService.timeoutMs': 500,
      });

      expect(() => createUserServiceClient(config, breakerFactory())).toThrow();
    });

    it('guards every call with the user-service breaker at the configured timeout', async () => {
      const config = fakeConfigService({
        'userService.internalUrl': url,
        'userService.internalApiToken': TOKEN,
        'userService.timeoutMs': 500,
      });
      const breakers = breakerFactory();
      const create = vi.spyOn(breakers, 'create');

      await expect(createUserServiceClient(config, breakers).userSummary(USER_ID)).resolves.toEqual(SUMMARY);
      expect(create).toHaveBeenCalledWith(USER_SERVICE_BREAKER, {
        timeoutMs: 500,
        isDownstreamFault: isUserServiceFault,
      });
    });
  });
});
