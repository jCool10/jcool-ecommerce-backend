import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDB } from '../../../database';
import {
  ORDER_REFUNDING_COLLECTOR_PROVIDERS,
  ORDER_REFUNDING_OLDEST_SECONDS,
  OrderRefundingCollectorBinding,
} from './order-refunding.collector';

type AgeRow = { oldestSeconds: string };

for (const provider of ORDER_REFUNDING_COLLECTOR_PROVIDERS as FactoryProvider[]) {
  if ('useFactory' in provider) provider.useFactory(undefined);
}

function fakeDb(answer: () => AgeRow[]) {
  const queries = vi.fn(() => Promise.resolve().then(answer));
  const db = { select: () => ({ from: () => ({ where: queries }) }) } as unknown as DrizzleDB;
  return { db, queries };
}

function bindTo(db: DrizzleDB, warn = vi.fn()) {
  const collector = new OrderRefundingCollectorBinding(db, fakePinoLogger({ warn }));
  collector.onModuleInit();
  return { collector, warn };
}

async function oldest(): Promise<number[]> {
  const metrics = await register.getMetricsAsJSON();
  return (metrics.find(({ name }) => name === ORDER_REFUNDING_OLDEST_SECONDS)?.values ?? []).map(({ value }) => value);
}

describe('order refunding collector', () => {
  let bound: OrderRefundingCollectorBinding | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    bound?.onModuleDestroy();
    bound = null;
    vi.useRealTimers();
  });

  it('reports how long the oldest order has been REFUNDING', async () => {
    bound = bindTo(fakeDb(() => [{ oldestSeconds: '1800.5' }]).db).collector;

    await expect(oldest()).resolves.toEqual([1800.5]);
  });

  it('reports 0 when no order is REFUNDING', async () => {
    bound = bindTo(fakeDb(() => [{ oldestSeconds: '0' }]).db).collector;

    await expect(oldest()).resolves.toEqual([0]);
  });

  it('holds the last value when the database fails, and warns at most once a minute', async () => {
    let fail = false;
    const { db } = fakeDb(() => {
      if (fail) throw new Error('connection refused');
      return [{ oldestSeconds: '30' }];
    });
    const { collector, warn } = bindTo(db);
    bound = collector;
    await oldest();

    fail = true;
    await expect(oldest()).resolves.toEqual([30]);
    await oldest();
    expect(warn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    await oldest();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives up on a hung query after 2s and lets the next scrape wait on that same query', async () => {
    let release: (rows: AgeRow[]) => void = () => undefined;
    const { db, queries } = fakeDb(() => [{ oldestSeconds: '5' }]);
    bound = bindTo(db).collector;
    await oldest();
    queries.mockImplementation(() => new Promise<AgeRow[]>((resolve) => (release = resolve)));

    for (let scrape = 0; scrape < 2; scrape += 1) {
      const reading = oldest();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(reading).resolves.toEqual([5]);
    }
    expect(queries).toHaveBeenCalledTimes(2);

    release([{ oldestSeconds: '6' }]);
    await vi.advanceTimersByTimeAsync(0);
    queries.mockResolvedValue([{ oldestSeconds: '7' }]);
    await expect(oldest()).resolves.toEqual([7]);
    expect(queries).toHaveBeenCalledTimes(3);
  });

  it('reports nothing once the app that bound it has closed', async () => {
    const { collector } = bindTo(fakeDb(() => [{ oldestSeconds: '1' }]).db);
    await oldest();

    collector.onModuleDestroy();

    await expect(oldest()).resolves.toEqual([]);
  });
});
