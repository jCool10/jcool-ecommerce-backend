import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from '@shared/infrastructure/redis';
import {
  buildJobOptions,
  DOMAIN_EVENTS_QUEUE,
  QUEUE_CONNECTION,
  QUEUE_DOMAIN_EVENTS,
} from '@shared/messaging/queue/queue.constants';
import { QueueLifecycle } from '@shared/messaging/queue/queue.lifecycle';
import { createTestApp } from '../setup/test-app.factory';

// The producer half of the queue over real Redis. Nothing consumes yet — a job added here stays
// waiting, which is what the relay hands off and the worker later picks up.
describe('BullMQ queue infrastructure (integration, real Redis)', () => {
  let app: INestApplication;
  let queue: Queue;
  let connection: Redis;
  let prefix: string;

  // Stand-in for the envelope the relay publishes; this suite only proves the transport.
  const job = { outboxId: '0198f0d8-0000-7000-8000-000000000001', occurredAt: '2026-08-24T00:00:00.000Z' };

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    connection = app.get<Redis>(QUEUE_CONNECTION);
    prefix = app.get(ConfigService).getOrThrow<string>('queue.prefix');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('publishes a job onto the domain-events queue with the configured retention', async () => {
    await queue.add('order.placed', job);

    expect(await queue.getWaitingCount()).toBe(1);
    const waiting = await queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe('order.placed');
    expect(waiting[0].data).toEqual(job);
    // Proves defaultJobOptions reached the queue rather than sitting unread in the constants file.
    // The retry policy above all: it is stamped onto the job at publish time, so a queue built
    // without it would hand the worker jobs that fail on their first try and never come back.
    const expected = buildJobOptions(
      app.get(ConfigService).getOrThrow<number>('queue.consumerAttempts'),
      app.get(ConfigService).getOrThrow<number>('queue.consumerBackoffMs'),
    );
    expect(waiting[0].opts).toMatchObject({
      attempts: expected.attempts,
      backoff: expected.backoff,
      removeOnComplete: expected.removeOnComplete,
      removeOnFail: expected.removeOnFail,
    });
  });

  it('namespaces its keys under the configured prefix', async () => {
    await queue.add('order.placed', job);

    const keys = await connection.keys(`${prefix}:${QUEUE_DOMAIN_EVENTS}:*`);
    expect(keys.length).toBeGreaterThan(0);
  });

  // The bug this whole file exists to prevent: BullMQ's blocking reads need an unbounded retry
  // budget, while the cache client is tuned to give up after one so a Redis outage falls through to
  // Postgres. One client cannot be both, so the queue gets its own.
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

    await isolatedQueue.add('order.placed', job); // force the connection ready before breaking it

    // Reconnecting — NOT disconnected — is the only state where the offline queue would kick in: a
    // closed client rejects everything before ever consulting it. Slow the retry so the window can't
    // close mid-assertion.
    isolatedConnection.options.retryStrategy = () => 5_000;
    isolatedConnection.stream.destroy();
    await vi.waitFor(() => expect(isolatedConnection.status).toBe('reconnecting'));

    // The message is the assertion: with the offline queue on, this publish would resolve after the
    // reconnect instead. Failing here leaves the outbox row unpublished for the next relay tick,
    // whereas buffering would accept a publish that dies with the process.
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

    // BullMQ treats a client it was handed as shared and never quits it, so a live connection here
    // would mean every boot leaks a socket. quit() resolves a macrotask before the status flips.
    await vi.waitFor(() => expect(isolatedConnection.status).toBe('end'));
  });

  it('does not hang shutting down when Redis is already gone', async () => {
    const isolated = await createTestApp();
    const lifecycle = isolated.get(QueueLifecycle);
    isolated.get<Redis>(QUEUE_CONNECTION).disconnect();

    // quit() rejects against a dead server; teardown has to fall through to disconnect() rather
    // than wait on it, or SIGTERM would stall until the orchestrator's kill timeout.
    const startedAt = Date.now();
    await lifecycle.onApplicationShutdown();
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await isolated.close();
  });
});
