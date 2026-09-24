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

const inRequest = (id = 'req-uuid'): ClsService => ({ isActive: () => true, getId: () => id }) as unknown as ClsService;
const outsideRequest = (): ClsService => ({ isActive: () => false }) as unknown as ClsService;

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
  const client = (timeoutMs = 1_000, breaker = passThrough, cls = inRequest()) =>
    new UserServiceClient({ url, token: TOKEN, timeoutMs }, breaker, cls);

  beforeEach(async () => {
    userService = new FakeUserService();
    url = await userService.start();
  });

  afterEach(() => userService.stop());

  it('carries the request id across the hop, and none from a queued job', async () => {
    await expect(client().userSummary(USER_ID)).resolves.toEqual(SUMMARY);
    await client(1_000, passThrough, outsideRequest()).userSummary(USER_ID);

    expect(userService.received.map(({ headers }) => headers['x-request-id'])).toEqual(['req-uuid', undefined]);
  });

  it('keeps an id inside its path segment', async () => {
    await client().userSummary('a/../b');

    expect(userService.received[0].url).toBe('/internal/v1/users/a%2F..%2Fb/summary');
  });

  it('reads a summary whose role it does not know', async () => {
    userService.reply = () => ({ status: 200, body: { ...SUMMARY, role: 'SUPPORT' } });

    await expect(client().userSummary(USER_ID)).resolves.toMatchObject({ email: SUMMARY.email });
  });

  it('rejects an error status or a malformed body, naming the endpoint', async () => {
    const summary = (c: UserServiceClient) => c.userSummary(USER_ID);
    const epoch = (c: UserServiceClient) => c.sessionEpoch(USER_ID);
    const summaryPath = `/internal/v1/users/${USER_ID}/summary`;
    const cases: [Reply, typeof summary | typeof epoch, string][] = [
      [{ status: 503, body: {} }, summary, summaryPath],
      [{ status: 401, body: {} }, summary, summaryPath],
      [{ status: 200, body: { id: USER_ID, role: 'CUSTOMER' } }, summary, summaryPath],
      [{ status: 200, body: undefined }, summary, summaryPath],
      [{ status: 200, body: { epoch: '3' } }, epoch, `/internal/v1/sessions/${USER_ID}/epoch`],
    ];

    for (const [reply, call, path] of cases) {
      userService.reply = () => reply;
      const error = await call(client()).catch((caught: unknown) => caught);

      expect(error, JSON.stringify(reply)).toBeInstanceOf(UserServiceRejection);
      expect((error as UserServiceRejection).path).toBe(path);
    }
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
});
