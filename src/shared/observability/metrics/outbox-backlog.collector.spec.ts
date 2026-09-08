import { Logger, type FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import {
  OUTBOX_BACKLOG_PENDING,
  OUTBOX_BACKLOG_PROVIDERS,
  OUTBOX_OLDEST_AGE_SECONDS,
} from './outbox-backlog.collector';

type BacklogRow = { pending: number; oldestAgeSeconds: string };

let queries = 0;
let answer: () => Promise<BacklogRow[]>;

// Enough of the drizzle builder for `select().from().where()`; `where()` is where the query issues,
// so that is what counts.
const db = {
  select: () => ({
    from: () => ({
      where: () => {
        queries += 1;
        return answer();
      },
    }),
  }),
} as unknown as DrizzleDB;

// Through the real factories, so the collect hooks land in the default registry as MetricsModule
// leaves them. willsoto puts its own options token first in `inject`, so db is the second argument.
for (const provider of OUTBOX_BACKLOG_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined, db);
}

function valueOf(text: string, name: string): number {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return Number(line?.slice(name.length + 1));
}

describe('outbox backlog collector', () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    queries = 0;
    warn.mockClear();
    answer = () => Promise.resolve([{ pending: 7, oldestAgeSeconds: '42.5' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the table once per scrape, no matter how many gauges ask', async () => {
    const text = await register.metrics();

    // prom-client starts both collect() calls before awaiting either, and they collapse into one
    // read — the property the e2e cannot observe.
    expect(queries).toBe(1);
    expect(valueOf(text, OUTBOX_BACKLOG_PENDING)).toBe(7);
    expect(valueOf(text, OUTBOX_OLDEST_AGE_SECONDS)).toBe(42.5);

    // …and nothing is cached across scrapes: the next one reads again.
    await register.metrics();
    expect(queries).toBe(2);
  });

  it('serves the scrape and holds the last value when the query fails', async () => {
    await register.metrics();
    answer = () => Promise.reject(new Error('connection terminated'));

    const text = await register.metrics();

    // A rejection here would fail the whole /metrics response and take every unrelated series with it.
    expect(valueOf(text, OUTBOX_BACKLOG_PENDING)).toBe(7);
    expect(valueOf(text, OUTBOX_OLDEST_AGE_SECONDS)).toBe(42.5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('abandons a query that hangs instead of hanging the scrape', async () => {
    await register.metrics();

    let release: (rows: BacklogRow[]) => void = () => undefined;
    answer = () => new Promise<BacklogRow[]>((resolve) => (release = resolve));

    vi.useFakeTimers();
    const scrape = register.metrics();
    await vi.advanceTimersByTimeAsync(2_000);
    const text = await scrape;

    expect(valueOf(text, OUTBOX_BACKLOG_PENDING)).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);

    // Let the abandoned query finish so it frees the shared slot for the next test.
    release([{ pending: 1, oldestAgeSeconds: '1' }]);
    await vi.advanceTimersByTimeAsync(0);
  });
});
