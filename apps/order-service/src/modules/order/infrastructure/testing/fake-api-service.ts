import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClsService } from 'nestjs-cls';
import { CircuitBreakerFactory } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';

export interface ReceivedRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type ApiReply = { status: number; body?: unknown; raw?: string } | 'hang';

/** The api's internal read routes on a real socket, so timeouts and refused connections are real too. */
export class FakeApiService {
  readonly received: ReceivedRequest[] = [];
  reply: (request: ReceivedRequest) => ApiReply = () => ({ status: 200, body: { lines: [] } });
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const request = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        };
        this.received.push(request);
        const reply = this.reply(request);
        if (reply === 'hang') return;
        res
          .writeHead(reply.status, { 'content-type': 'application/json' })
          .end(reply.raw ?? JSON.stringify(reply.body ?? {}));
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

export const inRequest = (id = 'req-uuid'): ClsService =>
  ({ isActive: () => true, getId: () => id }) as unknown as ClsService;

/** Opens after two faults in the window, so a spec sees the counting in a handful of calls. */
export function eagerBreakerFactory(): CircuitBreakerFactory {
  const config = fakeConfigService({
    'resilience.breaker.enabled': true,
    'resilience.breaker.timeoutMs': 3_000,
    'resilience.breaker.errorThresholdPercentage': 50,
    'resilience.breaker.resetTimeoutMs': 60_000,
    'resilience.breaker.rollingWindowMs': 10_000,
    'resilience.breaker.volumeThreshold': 2,
  });
  const cls = { exit: <T>(run: () => T): T => run() } as unknown as ClsService;
  return new CircuitBreakerFactory(config, fakeMetricsPort(), fakePinoLogger(), cls);
}
