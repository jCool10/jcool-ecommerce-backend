import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import {
  DOMAIN_EVENTS_QUEUE,
  QUEUE_CONNECTION,
  QUEUE_DOMAIN_EVENTS,
} from '../../src/shared/messaging/queue/queue.constants';
import { QueueLifecycle } from '../../src/shared/messaging/queue/queue.lifecycle';
import { closeAppAfterAll, obliterateQueueBeforeEach } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

// The lifecycle tests boot their own app because each breaks or closes its connection.
describe('BullMQ queue infrastructure (integration, real Redis)', () => {
  let app: INestApplication;
  let queue: Queue;
  let connection: Redis;
  let prefix: string;

  // Stand-in for the envelope the relay publishes; this suite only proves the transport.
  const job = { outboxId: '0198f0d8-0000-7000-8000-000000000001', occurredAt: '2026-08-24T00:00:00.000Z' };

  beforeAll(async () => {
    app = await createTestApp({ QUEUE_CONSUMER_ATTEMPTS: '5', QUEUE_CONSUMER_BACKOFF_MS: '250' });
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    connection = app.get<Redis>(QUEUE_CONNECTION);
    prefix = app.get(ConfigService).getOrThrow<string>('queue.prefix');
  });

  closeAppAfterAll(() => app);
  obliterateQueueBeforeEach(() => [queue]);

  it('publishes a job onto the domain-events queue with the configured retention', async () => {
    await queue.add('order.placed', job);

    expect(await queue.getWaitingCount()).toBe(1);
    const waiting = await queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe('order.placed');
    expect(waiting[0].data).toEqual(job);
    // Stamped at publish time: without it the worker would get jobs that never retry.
    expect(waiting[0].opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 250 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
  });

  it('namespaces its keys under the configured prefix', async () => {
    await queue.add('order.placed', job);

    const keys = await connection.keys(`${prefix}:${QUEUE_DOMAIN_EVENTS}:*`);
    expect(keys.length).toBeGreaterThan(0);
  });

  // BullMQ's blocking reads need unbounded retries; the cache client gives up after one.
  it('uses a connection separate from the cache client, tuned for blocking reads', () => {
    const cacheClient = app.get(RedisService).getClient();

    expect(connection).not.toBe(cacheClient);
    expect(connection.options.maxRetriesPerRequest).toBeNull();
    expect(cacheClient.options.maxRetriesPerRequest).toBe(1);
  });

  it('rejects a publish mid-reconnect instead of buffering it in memory', async () => {
    const isolated = await createTestApp();
    const isolatedQueue = isolated.get<Queue>(DOMAIN_EVENTS_QUEUE);
    const isolatedConnection = isolated.get<Redis>(QUEUE_CONNECTION);

    await isolatedQueue.add('order.placed', job);

    // Only a reconnecting client consults the offline queue; the slow retry holds that state.
    isolatedConnection.options.retryStrategy = () => 5_000;
    isolatedConnection.stream.destroy();
    await vi.waitFor(() => expect(isolatedConnection.status).toBe('reconnecting'));

    await expect(isolatedQueue.add('order.placed', job)).rejects.toThrow(/enableOfflineQueue/);

    await isolated.close();
  });

  it('closes the queue and its connection when the app shuts down', async () => {
    const isolated = await createTestApp();
    const isolatedQueue = isolated.get<Queue>(DOMAIN_EVENTS_QUEUE);
    const isolatedConnection = isolated.get<Redis>(QUEUE_CONNECTION);

    await isolatedQueue.add('order.placed', job);
    expect(isolatedConnection.status).toBe('ready');

    await isolated.close();

    // BullMQ never quits a client it was handed, so the app has to.
    await vi.waitFor(() => expect(isolatedConnection.status).toBe('end'));
  });

  it('does not hang shutting down when Redis is already gone', async () => {
    const isolated = await createTestApp();
    const lifecycle = isolated.get(QueueLifecycle);
    isolated.get<Redis>(QUEUE_CONNECTION).disconnect();

    const startedAt = Date.now();
    await lifecycle.onApplicationShutdown();
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await isolated.close();
  });
});
