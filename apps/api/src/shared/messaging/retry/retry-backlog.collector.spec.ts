import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { ConsumerRetryStore, RetryCount } from './consumer-retry.store';
import { MESSAGING_DEAD_LETTERS, MESSAGING_RETRY_PENDING, RETRY_BACKLOG_PROVIDERS } from './retry-backlog.collector';

let queries = 0;
let answer: () => Promise<RetryCount[]>;

const store = {
  countByStatus: () => {
    queries += 1;
    return answer();
  },
} as unknown as ConsumerRetryStore;

const warn = vi.fn();

// willsoto puts its own options token first in `inject`, so the store is the second argument.
for (const provider of RETRY_BACKLOG_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined, store, fakePinoLogger({ warn }));
}

function valueOf(text: string, name: string, consumer: string): number | undefined {
  const series = `${name}{consumer="${consumer}"} `;
  const line = text.split('\n').find((candidate) => candidate.startsWith(series));
  return line === undefined ? undefined : Number(line.slice(series.length));
}

describe('retry backlog collector', () => {
  beforeEach(() => {
    queries = 0;
    warn.mockClear();
    answer = () =>
      Promise.resolve([
        { consumer: 'domain-events', status: 'pending', rows: 3 },
        { consumer: 'domain-events', status: 'dead', rows: 1 },
        { consumer: 'search-sync', status: 'dead', rows: 2 },
      ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the table once per scrape and reports every consumer under both gauges', async () => {
    const text = await register.metrics();

    expect(queries).toBe(1);
    expect(valueOf(text, MESSAGING_RETRY_PENDING, 'domain-events')).toBe(3);
    expect(valueOf(text, MESSAGING_RETRY_PENDING, 'search-sync')).toBe(0);
    expect(valueOf(text, MESSAGING_DEAD_LETTERS, 'domain-events')).toBe(1);
    expect(valueOf(text, MESSAGING_DEAD_LETTERS, 'search-sync')).toBe(2);
  });

  // An alert cannot fire on a series that is not there, and a drained consumer is still a consumer.
  it('reports the domain-events consumer at zero once its rows are gone', async () => {
    await register.metrics();
    answer = () => Promise.resolve([]);

    const text = await register.metrics();

    expect(valueOf(text, MESSAGING_RETRY_PENDING, 'domain-events')).toBe(0);
    expect(valueOf(text, MESSAGING_DEAD_LETTERS, 'domain-events')).toBe(0);
    expect(valueOf(text, MESSAGING_DEAD_LETTERS, 'search-sync')).toBeUndefined();
  });

  it('keeps the last values when the query fails, warning once per read', async () => {
    await register.metrics();
    answer = () => Promise.reject(new Error('Connection terminated unexpectedly'));

    const text = await register.metrics();

    expect(valueOf(text, MESSAGING_RETRY_PENDING, 'domain-events')).toBe(3);
    expect(valueOf(text, MESSAGING_DEAD_LETTERS, 'search-sync')).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('abandons a query that hangs instead of hanging the scrape', async () => {
    await register.metrics();
    let release: (rows: RetryCount[]) => void = () => undefined;
    answer = () => new Promise<RetryCount[]>((resolve) => (release = resolve));

    vi.useFakeTimers();
    const scrape = register.metrics();
    await vi.advanceTimersByTimeAsync(2_000);
    const text = await scrape;

    expect(valueOf(text, MESSAGING_RETRY_PENDING, 'domain-events')).toBe(3);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
  });
});
