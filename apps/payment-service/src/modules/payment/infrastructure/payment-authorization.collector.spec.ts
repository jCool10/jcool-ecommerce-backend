import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../../database';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  PAYMENT_AUTHORIZATION_COLLECTOR_PROVIDERS,
  PAYMENT_AUTHORIZED_UNCAPTURED_OLDEST_SECONDS,
  PaymentAuthorizationCollectorBinding,
} from './payment-authorization.collector';

type AgeRow = { oldestSeconds: string };

for (const provider of PAYMENT_AUTHORIZATION_COLLECTOR_PROVIDERS as FactoryProvider[]) {
  if ('useFactory' in provider) provider.useFactory(undefined);
}

function fakeDb(answer: () => AgeRow[]) {
  const queries = vi.fn(() => Promise.resolve().then(answer));
  const db = { select: () => ({ from: () => ({ where: queries }) }) } as unknown as DrizzleDB;
  return { db, queries };
}

function bindTo(db: DrizzleDB, warn = vi.fn()) {
  const collector = new PaymentAuthorizationCollectorBinding(db, fakePinoLogger({ warn }));
  collector.onModuleInit();
  return { collector, warn };
}

async function oldest(): Promise<number[]> {
  const metrics = await register.getMetricsAsJSON();
  return (metrics.find(({ name }) => name === PAYMENT_AUTHORIZED_UNCAPTURED_OLDEST_SECONDS)?.values ?? []).map(
    ({ value }) => value,
  );
}

describe('payment authorization collector', () => {
  let bound: PaymentAuthorizationCollectorBinding | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    bound?.onModuleDestroy();
    bound = null;
    vi.useRealTimers();
  });

  it('reports the age of the oldest authorization still waiting for its capture', async () => {
    bound = bindTo(fakeDb(() => [{ oldestSeconds: '912.25' }]).db).collector;

    await expect(oldest()).resolves.toEqual([912.25]);
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
