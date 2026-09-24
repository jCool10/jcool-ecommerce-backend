import type { QueueOptions } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReplayOptions } from './dead-letter.replay';
import { buildJobOptions, ORDER_PAID_BACKOFF, QUEUE_DOMAIN_EVENTS, QUEUE_DOMAIN_EVENTS_DLQ } from './queue.constants';

// Hoisted because the mock factories below run before this module's own initialisation.
const built = vi.hoisted(() => ({
  queues: [] as { name: string; opts: QueueOptions }[],
  replayOptions: undefined as ReplayOptions | undefined,
}));

const outcome = vi.hoisted(() => ({
  skipped: {
    messageId: '0193c1f0-1111-7000-8000-000000000001',
    eventType: 'order.placed',
    status: 'skipped' as const,
    failedReason: 'ECONNREFUSED postgres:5432',
    detail: 'already applied at 2026-01-01T00:00:00.000Z, a replay would be a silent no-op',
  },
  replayed: {
    messageId: '0193c1f0-2222-7000-8000-000000000002',
    eventType: 'order.paid',
    status: 'replayed' as const,
    failedReason: 'handler threw TypeError',
  },
}));

// The CLI runs `main()` on import, so every I/O client it opens is stubbed and the run is observed
// through the constructor arguments and the options it hands the replay.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string, opts: QueueOptions) {
      built.queues.push({ name, opts });
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    quit(): Promise<void> {
      return Promise.resolve();
    }
    disconnect(): void {}
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => ({}) }));

vi.mock('./dead-letter.replay', () => ({
  replayDeadLetters: (_queue: unknown, _dlq: unknown, options: ReplayOptions) => {
    built.replayOptions = options;
    return Promise.resolve({ replayed: 1, skipped: 1, outcomes: [outcome.skipped, outcome.replayed] });
  },
}));

const ATTEMPTS = 3;
const BACKOFF_MS = 250;
const ORDER_PAID_ATTEMPTS = 12;

describe('replay-dlq CLI', () => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));

  const lineFor = (messageId: string): string => lines.find((line) => line.includes(messageId)) ?? '';

  beforeAll(async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('QUEUE_CONSUMER_ATTEMPTS', String(ATTEMPTS));
    vi.stubEnv('QUEUE_CONSUMER_BACKOFF_MS', String(BACKOFF_MS));
    vi.stubEnv('ORDER_PAID_CONSUMER_ATTEMPTS', String(ORDER_PAID_ATTEMPTS));
    // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
    await import('./replay-dlq.cli.js');
    // `main()` is a floating promise the import does not await, and the summary is printed after it.
    for (let attempt = 0; attempt < 200 && !lineFor(outcome.replayed.messageId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  afterAll(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  // Replayed without the app's ladder, a message that already failed gets no retry budget. The DLQ
  // has no consumer, so retention defaults there would delete the record it exists to keep.
  it("replays on the app's retry ladders and keeps job defaults off the DLQ", () => {
    const options = (name: string) => built.queues.find((queue) => queue.name === name)?.opts;

    expect(options(QUEUE_DOMAIN_EVENTS)?.defaultJobOptions).toEqual(buildJobOptions(ATTEMPTS, BACKOFF_MS));
    expect(built.replayOptions?.jobOptionsFor('order.paid')).toEqual({
      attempts: ORDER_PAID_ATTEMPTS,
      backoff: { type: ORDER_PAID_BACKOFF },
    });
    expect(options(QUEUE_DOMAIN_EVENTS_DLQ)).toBeDefined();
    expect(options(QUEUE_DOMAIN_EVENTS_DLQ)?.defaultJobOptions).toBeUndefined();
  });

  // Redis is the only other place the parked reason exists, and this tool runs when the app is broken.
  it('prints the labelled parked reason on each line, before the skip verdict', () => {
    const skipped = lineFor(outcome.skipped.messageId);

    expect(lineFor(outcome.replayed.messageId)).toContain(`[parked: ${outcome.replayed.failedReason}]`);
    expect(skipped).toContain(`[parked: ${outcome.skipped.failedReason}]`);
    expect(skipped.indexOf(outcome.skipped.failedReason)).toBeLessThan(skipped.indexOf(outcome.skipped.detail));
  });
});
