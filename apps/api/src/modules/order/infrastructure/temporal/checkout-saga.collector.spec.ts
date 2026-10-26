import type { FactoryProvider } from '@nestjs/common';
import type { Client, CountWorkflowExecution } from '@temporalio/client';
import { msNumberToTs } from '@temporalio/common/lib/time';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  CHECKOUT_SAGA_CLOSED_ABNORMALLY,
  CHECKOUT_SAGA_COLLECTOR_PROVIDERS,
  CHECKOUT_SAGA_ENGINE_UP,
  CHECKOUT_SAGA_OVERDUE,
  CHECKOUT_SAGA_TASK_QUEUE_BACKLOG_AGE_SECONDS,
  CHECKOUT_SAGA_TASK_QUEUE_POLLERS,
  CHECKOUT_SAGAS_OPEN,
  CheckoutSagaCollectorBinding,
} from './checkout-saga.collector';
import { checkoutSagaRunsOf } from './temporal-checkout-saga.engine';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const TASK_QUEUE = 'checkout-saga';
const OPEN = { RESERVING: 1, AWAITING_AUTH: 4, COMMITTING_STOCK: 0, CAPTURING: 2, COMPENSATING: 3 };

for (const provider of CHECKOUT_SAGA_COLLECTOR_PROVIDERS as FactoryProvider[]) {
  if ('useFactory' in provider) provider.useFactory(undefined);
}

function fakeTemporal() {
  const count = vi.fn((query: string): Promise<CountWorkflowExecution> => {
    if (query.includes('GROUP BY')) {
      return Promise.resolve({
        count: 6,
        groups: [
          { count: 2, groupValues: [['Terminated']] },
          { count: 1, groupValues: [['Failed']] },
          { count: 3, groupValues: [['Completed']] },
        ],
      });
    }
    const step = /CheckoutStep = '(\w+)'/.exec(query)?.[1] as keyof typeof OPEN | undefined;
    return Promise.resolve({ count: step ? OPEN[step] : 5, groups: [] });
  });
  const describeTaskQueue = vi.fn(({ taskQueueType }: { taskQueueType: number }) =>
    Promise.resolve(
      taskQueueType === 1
        ? {
            pollers: [
              { lastAccessTime: msNumberToTs(NOW.getTime() - 5_000) },
              { lastAccessTime: msNumberToTs(NOW.getTime() - 61_000) },
            ],
            stats: { approximateBacklogAge: msNumberToTs(1_500) },
          }
        : { pollers: [{ lastAccessTime: msNumberToTs(NOW.getTime() - 1_000) }] },
    ),
  );
  const deadlines: number[] = [];
  const client = {
    workflow: { count },
    workflowService: { describeTaskQueue },
    connection: {
      withDeadline: vi.fn((deadline: number, fn: () => Promise<unknown>) => {
        deadlines.push(deadline);
        return fn();
      }),
    },
  } as unknown as Client;
  return { client, count, describeTaskQueue, deadlines };
}

function bindTo(client: Client, warn = vi.fn()) {
  const collector = new CheckoutSagaCollectorBinding(
    client,
    fakeConfigService({
      checkoutSaga: { overdueGraceSec: 300, temporal: { namespace: 'jcool', taskQueue: TASK_QUEUE } },
    }),
    fakePinoLogger({ warn }),
  );
  collector.onModuleInit();
  return { collector, warn };
}

/** A count that answers only when told to. */
function heldCount(temporal: ReturnType<typeof fakeTemporal>): () => void {
  let answer = (): void => undefined;
  temporal.count.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ count: 1, groups: [] });
      }),
  );
  return () => answer();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function scrape() {
  const metrics = await register.getMetricsAsJSON();
  const series = (name: string) => metrics.find((metric) => metric.name === name)?.values ?? [];
  const byLabel = (name: string, label: string): Record<string, number> =>
    Object.fromEntries(series(name).map(({ labels, value }) => [String(labels[label]), value] as const));
  return { series, byLabel };
}

describe('checkout saga collector', () => {
  let bound: CheckoutSagaCollectorBinding | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  afterEach(async () => {
    await bound?.onModuleDestroy();
    bound = null;
    vi.useRealTimers();
  });

  it('reads every saga gauge from one round of calls under a 2s deadline', async () => {
    const temporal = fakeTemporal();
    bound = bindTo(temporal.client).collector;

    await scrape();

    expect(temporal.count).toHaveBeenCalledTimes(7);
    expect(temporal.describeTaskQueue).toHaveBeenCalledTimes(2);
    expect(temporal.deadlines).toEqual([NOW.getTime() + 2_000]);
  });

  it('only counts the sagas of its own task queue', async () => {
    const temporal = fakeTemporal();
    bound = bindTo(temporal.client).collector;

    await scrape();

    for (const [query] of temporal.count.mock.calls) {
      expect(query.startsWith(checkoutSagaRunsOf(TASK_QUEUE))).toBe(true);
    }
    expect(temporal.describeTaskQueue.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ namespace: 'jcool', taskQueue: { name: TASK_QUEUE, kind: 1 }, reportStats: true }),
      expect.objectContaining({ namespace: 'jcool', taskQueue: { name: TASK_QUEUE, kind: 1 }, reportStats: true }),
    ]);
  });

  it('reports open sagas per step and the overdue ones past deadline plus grace', async () => {
    const temporal = fakeTemporal();
    bound = bindTo(temporal.client).collector;

    const { series, byLabel } = await scrape();

    expect(byLabel(CHECKOUT_SAGAS_OPEN, 'step')).toEqual(OPEN);
    expect(series(CHECKOUT_SAGA_OVERDUE)).toEqual([expect.objectContaining({ value: 5 })]);
    expect(temporal.count).toHaveBeenCalledWith(
      `${checkoutSagaRunsOf(TASK_QUEUE)} AND ExecutionStatus = 'Running' AND CheckoutDeadlineAt < '2026-10-24T09:55:00.000Z'`,
    );
    expect(temporal.count).toHaveBeenCalledWith(
      `${checkoutSagaRunsOf(TASK_QUEUE)} AND ExecutionStatus = 'Running' AND CheckoutStep = 'AWAITING_AUTH'`,
    );
  });

  it('reports the last hour of abnormal closes, zero for a status that had none', async () => {
    const temporal = fakeTemporal();
    bound = bindTo(temporal.client).collector;

    const { byLabel } = await scrape();

    expect(byLabel(CHECKOUT_SAGA_CLOSED_ABNORMALLY, 'status')).toEqual({
      Failed: 1,
      Terminated: 2,
      TimedOut: 0,
      Canceled: 0,
    });
    expect(temporal.count).toHaveBeenCalledWith(
      `${checkoutSagaRunsOf(TASK_QUEUE)} AND CloseTime > '2026-10-24T09:00:00.000Z' GROUP BY ExecutionStatus`,
    );
  });

  it('counts only pollers seen in the last minute, and backlog age 0 without stats', async () => {
    bound = bindTo(fakeTemporal().client).collector;

    const { byLabel } = await scrape();

    expect(byLabel(CHECKOUT_SAGA_TASK_QUEUE_POLLERS, 'task_type')).toEqual({ workflow: 1, activity: 1 });
    expect(byLabel(CHECKOUT_SAGA_TASK_QUEUE_BACKLOG_AGE_SECONDS, 'task_type')).toEqual({
      workflow: 1.5,
      activity: 0,
    });
  });

  it('reports the engine up when every call answered', async () => {
    bound = bindTo(fakeTemporal().client).collector;

    const { series } = await scrape();

    expect(series(CHECKOUT_SAGA_ENGINE_UP)).toEqual([expect.objectContaining({ value: 1 })]);
  });

  it('withdraws the saga gauges rather than hold them when one call fails', async () => {
    const temporal = fakeTemporal();
    bound = bindTo(temporal.client).collector;
    await scrape();
    temporal.describeTaskQueue.mockRejectedValueOnce(new Error('deadline exceeded'));

    const { series } = await scrape();

    expect(series(CHECKOUT_SAGA_ENGINE_UP)).toEqual([expect.objectContaining({ value: 0 })]);
    for (const name of [
      CHECKOUT_SAGAS_OPEN,
      CHECKOUT_SAGA_OVERDUE,
      CHECKOUT_SAGA_CLOSED_ABNORMALLY,
      CHECKOUT_SAGA_TASK_QUEUE_POLLERS,
      CHECKOUT_SAGA_TASK_QUEUE_BACKLOG_AGE_SECONDS,
    ]) {
      expect(series(name), name).toEqual([]);
    }
  });

  it('waits for every call before giving up on a failed one, so none outlives the scrape', async () => {
    const temporal = fakeTemporal();
    const answer = heldCount(temporal);
    temporal.describeTaskQueue.mockRejectedValueOnce(new Error('unavailable'));
    bound = bindTo(temporal.client).collector;

    let settled = false;
    const scraped = scrape().finally(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    answer();
    const { series } = await scraped;
    expect(series(CHECKOUT_SAGA_ENGINE_UP)).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it('holds the app shutdown until the scrape in flight is done with the connection', async () => {
    const temporal = fakeTemporal();
    const answer = heldCount(temporal);
    const { collector } = bindTo(temporal.client);
    const scraped = scrape();
    await flush();

    let closed = false;
    const closing = collector.onModuleDestroy().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);

    answer();
    await Promise.all([scraped, closing]);
    expect(closed).toBe(true);
  });

  it('warns at most once a minute while Temporal stays unreachable', async () => {
    const temporal = fakeTemporal();
    temporal.count.mockRejectedValue(new Error('unavailable'));
    const { collector, warn } = bindTo(temporal.client);
    bound = collector;

    await scrape();
    vi.setSystemTime(NOW.getTime() + 59_000);
    await scrape();
    expect(warn).toHaveBeenCalledOnce();

    vi.setSystemTime(NOW.getTime() + 60_000);
    await scrape();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports nothing once the app that bound it has closed', async () => {
    const { collector } = bindTo(fakeTemporal().client);
    await scrape();

    await collector.onModuleDestroy();
    const { series } = await scrape();

    expect(series(CHECKOUT_SAGA_ENGINE_UP)).toEqual([]);
    expect(series(CHECKOUT_SAGAS_OPEN)).toEqual([]);
  });

  it('keeps the newer app bound when an older one closes after it', async () => {
    const older = bindTo(fakeTemporal().client).collector;
    const newer = fakeTemporal();
    bound = bindTo(newer.client).collector;

    await older.onModuleDestroy();
    await scrape();

    expect(newer.count).toHaveBeenCalled();
  });
});
