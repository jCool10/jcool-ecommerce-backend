import type { FactoryProvider } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { consumersOf, fakeDispatcher } from '../testing/fake-dispatcher';
import { ORDERS } from '../testing/messaging-fixtures';
import {
  MESSAGING_QUEUE_JOBS,
  MESSAGING_QUEUE_OLDEST_WAITING_SECONDS,
  QUEUE_DEPTH_COLLECTOR_PROVIDERS,
  QueueDepthCollectorBinding,
} from './queue-depth.collector';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const COUNTS = { wait: 3, prioritized: 2, active: 1, delayed: 4 };

for (const provider of QUEUE_DEPTH_COLLECTOR_PROVIDERS as FactoryProvider[]) {
  if ('useFactory' in provider) provider.useFactory(undefined);
}

function fakeQueue(oldestAgeMs: number | null = 90_000, name = 'orders') {
  const getJobCounts = vi.fn(() => Promise.resolve({ ...COUNTS }));
  const getJobs = vi.fn(() =>
    Promise.resolve(oldestAgeMs === null ? [] : [{ timestamp: NOW.getTime() - oldestAgeMs } as unknown as Job]),
  );
  return { queue: { name, getJobCounts, getJobs } as unknown as Queue, getJobCounts, getJobs };
}

// Bound to the consumed queues only; their dead letters sit in the same map and must stay out.
function bindTo(queue: Queue | Queue[], warn = vi.fn()) {
  const queues = [queue].flat();
  const dlqs = queues.map((consumed) => fakeQueue(1_000, `${consumed.name}-dlq`).queue);
  const dispatcher = fakeDispatcher({});
  const collector = new QueueDepthCollectorBinding(
    new Map([...queues, ...dlqs].map((q) => [q.name, q])),
    consumersOf(...queues.map((q) => ({ spec: { ...ORDERS, name: q.name, dlq: `${q.name}-dlq` }, dispatcher }))),
    fakePinoLogger({ warn }),
  );
  collector.onModuleInit();
  return { collector, warn };
}

async function scrape() {
  const metrics = await register.getMetricsAsJSON();
  return (name: string) => metrics.find((metric) => metric.name === name)?.values ?? [];
}

describe('queue depth collector', () => {
  let bound: QueueDepthCollectorBinding | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
  });

  afterEach(() => {
    bound?.onModuleDestroy();
    bound = null;
    vi.useRealTimers();
  });

  it('reports jobs per state and the oldest waiting one, from one read per scrape', async () => {
    const { queue, getJobCounts, getJobs } = fakeQueue();
    bound = bindTo(queue).collector;

    const series = await scrape();

    expect(series(MESSAGING_QUEUE_JOBS)).toEqual(
      Object.entries(COUNTS).map(([state, value]) => ({ labels: { queue: 'orders', state }, value })),
    );
    expect(series(MESSAGING_QUEUE_OLDEST_WAITING_SECONDS)).toEqual([{ labels: { queue: 'orders' }, value: 90 }]);
    expect(getJobCounts).toHaveBeenCalledExactlyOnceWith('wait', 'prioritized', 'active', 'delayed');
    expect(getJobs).toHaveBeenCalledExactlyOnceWith(['wait'], 0, 0, true);
  });

  it('reports every consumed queue under its own label and none of their dead letters', async () => {
    bound = bindTo([fakeQueue(30_000, 'orders').queue, fakeQueue(60_000, 'catalog').queue]).collector;

    const series = await scrape();

    expect(series(MESSAGING_QUEUE_OLDEST_WAITING_SECONDS)).toEqual([
      { labels: { queue: 'orders' }, value: 30 },
      { labels: { queue: 'catalog' }, value: 60 },
    ]);
    expect(new Set(series(MESSAGING_QUEUE_JOBS).map(({ labels }) => labels.queue))).toEqual(
      new Set(['orders', 'catalog']),
    );
  });

  it('reports 0 for the oldest waiting job when nothing waits', async () => {
    bound = bindTo(fakeQueue(null).queue).collector;

    const series = await scrape();

    expect(series(MESSAGING_QUEUE_OLDEST_WAITING_SECONDS)).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it('holds the last sample when Redis fails, and warns at most once a minute', async () => {
    const { queue, getJobCounts } = fakeQueue();
    const { collector, warn } = bindTo(queue);
    bound = collector;
    await scrape();
    getJobCounts.mockRejectedValue(new Error('Connection is closed.'));

    const series = await scrape();
    await scrape();

    expect(series(MESSAGING_QUEUE_OLDEST_WAITING_SECONDS)).toEqual([expect.objectContaining({ value: 90 })]);
    expect(series(MESSAGING_QUEUE_JOBS)).toHaveLength(4);
    expect(warn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    await scrape();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives up on a Redis read after 2s', async () => {
    const { queue, getJobCounts } = fakeQueue();
    bound = bindTo(queue).collector;
    await scrape();
    let release: () => void = () => undefined;
    getJobCounts.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ...COUNTS }))));

    const reading = scrape();
    await vi.advanceTimersByTimeAsync(2_000);
    const series = await reading;

    expect(series(MESSAGING_QUEUE_JOBS)).toHaveLength(4);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('reports nothing once the app that bound it has closed', async () => {
    const { collector } = bindTo(fakeQueue().queue);
    await scrape();

    collector.onModuleDestroy();
    const series = await scrape();

    expect(series(MESSAGING_QUEUE_JOBS)).toEqual([]);
    expect(series(MESSAGING_QUEUE_OLDEST_WAITING_SECONDS)).toEqual([]);
  });
});
