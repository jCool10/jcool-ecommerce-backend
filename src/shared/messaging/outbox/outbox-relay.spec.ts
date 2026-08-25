import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { DomainEventJob } from '../queue/domain-event.job';
import { OutboxRelay } from './outbox-relay';
import type { outbox } from './schema/outbox.schema';

type OutboxRow = typeof outbox.$inferSelect;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PRODUCER_SPAN_ID = '00f067aa0ba902b7';
// `expect.any` is typed `any`; widening to unknown keeps these assertions inside the lint rules.
const MARKED_PUBLISHED = { publishedAt: expect.any(Date) as unknown };

let nextId = 1;
function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `0198f0d8-0000-7000-8000-${String(nextId++).padStart(12, '0')}`,
    aggregateType: 'Order',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType: 'order.placed',
    payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
    traceparent: null,
    attempts: 0,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
    publishedAt: null,
    ...overrides,
  };
}

/**
 * A transaction handle that replays a fixed batch and records what the relay wrote back, so the
 * poll's locking clause and the failure policy can be pinned without a database.
 */
function build(rows: OutboxRow[]) {
  const writes: Record<string, unknown>[] = [];
  const limits: number[] = [];
  let lockClause: unknown[] = [];

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              limits.push(n);
              return {
                for: (...args: unknown[]) => {
                  lockClause = args;
                  return Promise.resolve(rows.slice(0, n));
                },
              };
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({ where: () => (writes.push(values), Promise.resolve()) }),
    }),
  };

  const transaction = vi.fn((run: (t: unknown) => unknown) => run(tx));
  const add = vi.fn().mockResolvedValue(undefined);
  const connection = { status: 'ready' };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const relay = new OutboxRelay(
    { transaction } as unknown as DrizzleDB,
    { add } as unknown as Queue,
    connection as unknown as Redis,
    logger as unknown as PinoLogger,
  );

  const jobs = () => add.mock.calls.map(([, job]) => job as DomainEventJob);
  return { relay, transaction, add, connection, logger, writes, limits, jobs, lock: () => lockClause };
}

describe('OutboxRelay', () => {
  // The globals the SDK installs at boot. Without them `withSpan` yields a non-recording span and
  // injection produces nothing, so the trace assertions below would pass vacuously.
  const contextManager = new AsyncLocalStorageContextManager();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
    context.setGlobalContextManager(contextManager.enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    contextManager.disable();
    context.disable();
    trace.disable();
    propagation.disable();
  });

  describe('polling', () => {
    it('claims the batch with FOR UPDATE SKIP LOCKED so a second instance takes different rows', async () => {
      const t = build([row(), row()]);

      await t.relay.runOnce(50);

      expect(t.lock()).toEqual(['update', { skipLocked: true }]);
      expect(t.limits).toEqual([50]);
    });

    it('publishes each row and marks it published in the same transaction', async () => {
      const rows = [row(), row(), row()];
      const t = build(rows);

      await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 3, failed: 0 });

      expect(t.add).toHaveBeenCalledTimes(3);
      expect(t.jobs().map((job) => job.outboxId)).toEqual(rows.map((r) => r.id));
      expect(t.writes).toEqual([MARKED_PUBLISHED, MARKED_PUBLISHED, MARKED_PUBLISHED]);
    });

    it('keys the job on the row id so a redelivered row is not queued twice', async () => {
      const only = row();
      const t = build([only]);

      await t.relay.runOnce(10);

      expect(t.add).toHaveBeenCalledWith(only.eventType, expect.anything(), { jobId: only.id });
    });
  });

  describe('publish failures', () => {
    it('charges the refused row and keeps going, so one bad event cannot block the backlog', async () => {
      const rows = [row(), row(), row()];
      const t = build(rows);
      t.add.mockRejectedValueOnce(new Error('payload too large')).mockResolvedValue(undefined);

      await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 2, failed: 1 });

      // The refused row is the head of the batch, and the two behind it still reach the queue —
      // otherwise it would sort first on every future tick and pin the whole backlog behind it.
      expect(t.writes).toEqual([MARKED_PUBLISHED, MARKED_PUBLISHED, { attempts: 1 }]);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outboxId: rows[0].id, refused: 1, charged: true }),
        expect.stringContaining('payload too large'),
      );
    });

    it('charges nothing when the queue refused every row, however healthy the socket looks', async () => {
      const t = build([row(), row(), row()]);
      // What a Redis that is up but refusing writes returns: out of memory, a read-only replica
      // after failover, a reload from disk. The connection stays `ready` throughout.
      t.add.mockRejectedValue(new Error("OOM command not allowed when used memory > 'maxmemory'"));

      await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 3 });

      // Nothing written at all: a minute of failover must not add a minute of attempts to every row
      // in the backlog, or a retry budget would later read healthy events as poison.
      expect(t.writes).toEqual([]);
      expect(t.connection.status).toBe('ready');
      expect(t.logger.warn).toHaveBeenCalledOnce();
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ refused: 3, charged: false }),
        expect.stringContaining('OOM'),
      );
    });

    it('gives up on the batch after a few refusals rather than paying the queue timeout per row', async () => {
      const t = build(Array.from({ length: 20 }, () => row()));
      t.add.mockRejectedValue(new Error('Command timed out'));

      await t.relay.runOnce(20);

      // Each refusal can cost a full command timeout, so an unbounded batch would hold the
      // transaction — and its row locks — open for timeout x batch size.
      expect(t.add).toHaveBeenCalledTimes(3);
    });

    it('skips the tick entirely while Redis is away, without opening a transaction', async () => {
      const t = build([row()]);
      t.connection.status = 'reconnecting';

      await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });

      expect(t.transaction).not.toHaveBeenCalled();
      expect(t.add).not.toHaveBeenCalled();
      expect(t.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('trace continuity', () => {
    it('continues the producer trace under a fresh publish span', async () => {
      const stored = `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-01`;
      const t = build([row({ traceparent: stored })]);

      await t.relay.runOnce(10);

      const [job] = t.jobs();
      expect(job.traceparent).toContain(TRACE_ID);
      // A fresh span id, or the consumer would nest under the request instead of under the publish.
      expect(job.traceparent).not.toBe(stored);
      expect(job.traceparent?.endsWith('-01')).toBe(true);
    });

    it('preserves the sampling decision it was handed', async () => {
      const t = build([row({ traceparent: `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-00` })]);

      await t.relay.runOnce(10);

      // Re-injecting must not promote an unsampled trace, or a dropped request reappears downstream
      // as a partial trace with no root.
      expect(t.jobs()[0].traceparent?.endsWith('-00')).toBe(true);
    });

    it('roots its own trace when the row carries none', async () => {
      const t = build([row()]);

      await t.relay.runOnce(10);

      // Events written outside a request still get a trace to hang off — one rooted at the publish
      // rather than linked to a caller that never existed.
      expect(t.jobs()[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    });
  });

  // Production and e2e both run with OTEL_ENABLED unset, so this is the common path, not the edge.
  describe('trace continuity with no tracing SDK', () => {
    beforeAll(() => {
      trace.disable();
    });

    afterAll(() => {
      trace.setGlobalTracerProvider(provider);
    });

    it('forwards the header stored on the row', async () => {
      const stored = `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-01`;
      const t = build([row({ traceparent: stored })]);

      await t.relay.runOnce(10);

      // No SDK means nothing to inject; dropping the row's header here would lose the only trace
      // context the event ever had.
      expect(t.jobs()[0].traceparent).toBe(stored);
    });

    it('carries null rather than a fabricated header', async () => {
      const t = build([row()]);

      await t.relay.runOnce(10);

      expect(t.jobs()[0].traceparent).toBeNull();
    });
  });
});
