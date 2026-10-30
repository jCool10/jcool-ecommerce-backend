import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

/** Temporal behind a cable the test can pull and plug back in, on the same port both times. */
class TemporalCable {
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  async plug(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(this.target.port, this.target.host);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async pull(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Readiness while Temporal goes away and comes back (integration)', () => {
  let app: INestApplication;
  let cable: TemporalCable;

  beforeAll(async () => {
    const [host, port] = inject('TEMPORAL_ADDRESS').split(':');
    cable = new TemporalCable({ host, port: Number(port) });
    await cable.plug();
    ({ app } = await createTestAppWithPool({
      TEMPORAL_ADDRESS: cable.address,
      TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('cable'),
      TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: '500',
      TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: '500',
    }));
  });
  closeAppAfterAll(() => app);
  afterAll(() => cable.pull());

  const ready = () => request(app.getHttpServer()).get('/health/ready');
  const untilReady = (status: number, timeout: number) =>
    vi.waitFor(async () => expect((await ready()).status).toBe(status), { timeout, interval: 250 });

  it('drops out of rotation without Temporal, stays alive, and comes back once it answers again', async () => {
    await untilReady(200, 30_000);

    await cable.pull();

    await untilReady(503, 10_000);
    expect((await ready()).body.error.temporal).toEqual({ status: 'down', message: 'temporal unreachable' });
    await request(app.getHttpServer()).get('/health/live').expect(200);

    await cable.plug();

    // gRPC reconnects on a backoff and the worker supervisor on its own, so recovery takes a few probes.
    await untilReady(200, 45_000);
    expect((await ready()).body.details.temporal).toEqual({ status: 'up' });
  }, 90_000);
});
