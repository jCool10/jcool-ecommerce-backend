import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { bucketOf, encode } from '@jcool/id-codec';
import { CircuitBreakerFactory, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ID_SERVICE_BREAKER, IdServiceHttpAdapter, isIdServiceFault } from './id-service.http-adapter';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

type Reply = { status: number; body: unknown } | 'hang';

const idIn = (bucket: number, sequence = 0): string => encode({ tsMs: Date.now(), bucket, nodeId: 1, sequence });

class FakeIdService {
  readonly received: Received[] = [];
  reply: (request: Received) => Reply = (request) => {
    const { bucket, count } = request.body as { bucket: number; count: number };
    return { status: 200, body: { ids: Array.from({ length: count }, (_, i) => idIn(bucket, i)) } };
  };
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) as unknown };
        this.received.push(request);
        const reply = this.reply(request);
        if (reply === 'hang') return;
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
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

const leaseNotHeld: Reply = { status: 503, body: { statusCode: 503, code: 'LEASE_NOT_HELD' } };
const passThrough: OutboundCall = { run: (task) => task() };

const inRequest = (id = 'req-uuid'): ClsService => ({ isActive: () => true, getId: () => id }) as unknown as ClsService;

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

describe('IdServiceHttpAdapter', () => {
  let idService: FakeIdService;
  let url: string;

  beforeEach(async () => {
    idService = new FakeIdService();
    url = await idService.start();
  });

  afterEach(() => idService.stop());

  it('asks for ids in a bucket and names itself as the caller', async () => {
    const adapter = new IdServiceHttpAdapter({ url, timeoutMs: 1_000 }, passThrough, inRequest());

    const ids = await adapter.mint(42, 2);

    expect(ids.map(bucketOf)).toEqual([42, 42]);
    expect(idService.received).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/v1/ids',
        headers: expect.objectContaining({
          'x-caller': 'user-service',
          'content-type': 'application/json',
          // The id service logs the caller's id rather than minting one, so both hops read as one request.
          'x-request-id': 'req-uuid',
        }) as IncomingHttpHeaders,
        body: { bucket: 42, count: 2 },
      }),
    ]);
  });

  /** Asks for two ids in bucket 1 against each reply, recording the answer and how many requests it took. */
  async function answersTo(replies: Record<string, Reply>): Promise<Record<string, string>> {
    const adapter = new IdServiceHttpAdapter({ url, timeoutMs: 1_000 }, passThrough, inRequest());
    const answers: Record<string, string> = {};
    for (const [name, reply] of Object.entries(replies)) {
      idService.reply = () => reply;
      const before = idService.received.length;
      const answer = await adapter.mint(1, 2).then(
        () => 'ids',
        (error: unknown) => (error instanceof ServiceUnavailableException ? '503' : String(error)),
      );
      answers[name] = `${answer} after ${idService.received.length - before} request`;
    }
    return answers;
  }

  // The gateway owns the only retry budget, so every failure costs exactly one request.
  it('answers 503 after one request when the id service refuses', async () => {
    const answers = await answersTo({
      'no lease held anywhere': leaseNotHeld,
      'a server error': { status: 500, body: {} },
      'a rejected request': { status: 400, body: {} },
    });

    expect(answers).toEqual({
      'no lease held anywhere': '503 after 1 request',
      'a server error': '503 after 1 request',
      'a rejected request': '503 after 1 request',
    });
  });

  it('answers 503 after one request for a reply that is not the ids it asked for', async () => {
    const answers = await answersTo({
      'a body without ids': { status: 200, body: {} },
      'fewer ids than asked for': { status: 200, body: { ids: [idIn(1)] } },
      'ids that are not strings': { status: 200, body: { ids: [1, 2] } },
      'ids that are not routable': { status: 200, body: { ids: [crypto.randomUUID(), crypto.randomUUID()] } },
      'ids from another bucket': { status: 200, body: { ids: [idIn(1), idIn(2)] } },
    });

    expect(answers).toEqual({
      'a body without ids': '503 after 1 request',
      'fewer ids than asked for': '503 after 1 request',
      'ids that are not strings': '503 after 1 request',
      'ids that are not routable': '503 after 1 request',
      'ids from another bucket': '503 after 1 request',
    });
  });

  it('answers 503 once the timeout runs out', async () => {
    idService.reply = () => 'hang';
    const adapter = new IdServiceHttpAdapter({ url, timeoutMs: 100 }, passThrough, inRequest());

    await expect(adapter.mint(1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('behind the breaker', () => {
    function adapterBehindBreaker(): IdServiceHttpAdapter {
      const breaker = breakerFactory().create(ID_SERVICE_BREAKER, { isDownstreamFault: isIdServiceFault });
      return new IdServiceHttpAdapter({ url, timeoutMs: 1_000 }, breaker, inRequest());
    }

    it('keeps the circuit closed through LEASE_NOT_HELD answers', async () => {
      const adapter = adapterBehindBreaker();
      idService.reply = () => leaseNotHeld;
      for (let i = 0; i < 5; i++) await adapter.mint(1).catch(() => undefined);

      const fresh = idIn(1);
      idService.reply = () => ({ status: 200, body: { ids: [fresh] } });

      await expect(adapter.mint(1)).resolves.toEqual([fresh]);
      expect(idService.received).toHaveLength(6);
    });

    it('opens the circuit on server errors and stops calling', async () => {
      const adapter = adapterBehindBreaker();
      idService.reply = () => ({ status: 500, body: {} });
      for (let i = 0; i < 5; i++) await adapter.mint(1).catch(() => undefined);
      const reached = idService.received.length;

      await expect(adapter.mint(1)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(idService.received).toHaveLength(reached);
    });
  });
});
