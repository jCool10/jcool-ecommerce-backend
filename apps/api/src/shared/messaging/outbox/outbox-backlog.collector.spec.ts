import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
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

const warn = vi.fn();

// Through the real factories, so the collect hooks land in the default registry as MessagingModule
// leaves them. willsoto puts its own options token first in `inject`, so db is the second argument
// and the logger the third.
for (const provider of OUTBOX_BACKLOG_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined, db, fakePinoLogger({ warn }));
}

function valueOf(text: string, name: string): number {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return Number(line?.slice(name.length + 1));
}

describe('outbox backlog collector', () => {
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

    // prom-client starts both collect() calls before awaiting either, and they collapse into one read.
    expect(queries).toBe(1);
    expect(valueOf(text, OUTBOX_BACKLOG_PENDING)).toBe(7);
    expect(valueOf(text, OUTBOX_OLDEST_AGE_SECONDS)).toBe(42.5);

    await register.metrics();
    expect(queries).toBe(2);
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
