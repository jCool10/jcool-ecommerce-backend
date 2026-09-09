import type { QueueOptions } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildJobOptions, QUEUE_DOMAIN_EVENTS, QUEUE_DOMAIN_EVENTS_DLQ } from './queue.constants';

// Hoisted because the mock factories below run before this module's own initialisation.
const built = vi.hoisted(() => ({ queues: [] as { name: string; opts: QueueOptions }[] }));

// The summary the CLI renders. Both fields exist only in Redis, so the printed line is the operator's
// only sight of them.
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
// through the constructor arguments — the queue's options are what decide a replayed job's policy.
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
  replayDeadLetters: () => Promise.resolve({ replayed: 1, skipped: 1, outcomes: [outcome.skipped, outcome.replayed] }),
}));

const ATTEMPTS = 3;
const BACKOFF_MS = 250;

describe('replay-dlq CLI', () => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));

  const lineFor = (messageId: string): string => lines.find((line) => line.includes(messageId)) ?? '';

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    process.env.QUEUE_CONSUMER_ATTEMPTS = String(ATTEMPTS);
    process.env.QUEUE_CONSUMER_BACKOFF_MS = String(BACKOFF_MS);
    // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
    await import('./replay-dlq.cli.js');
    // `main()` is a floating promise the import does not await, and the summary is printed after it.
    for (let attempt = 0; attempt < 200 && !lineFor(outcome.replayed.messageId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  afterAll(() => {
    log.mockRestore();
  });

  // A dead letter is by definition a message that already failed, so replaying it without the app's
  // retry budget spends no attempts before parking it again — and its failed record, kept forever
  // without the retention bound, can outlive the inbox claim that stops a second application.
  it('publishes replays under the same retry and retention policy the app runs', () => {
    const domainEvents = built.queues.find((q) => q.name === QUEUE_DOMAIN_EVENTS);

    expect(domainEvents?.opts.defaultJobOptions).toEqual(buildJobOptions(ATTEMPTS, BACKOFF_MS));
  });

  // Retention rules on the queue nothing consumes would delete the record it exists to keep.
  it('leaves the dead-letter queue itself without job defaults', () => {
    const dlq = built.queues.find((q) => q.name === QUEUE_DOMAIN_EVENTS_DLQ);

    expect(dlq).toBeDefined();
    expect(dlq?.opts.defaultJobOptions).toBeUndefined();
  });

  // The header tells the operator to fix the failure before replaying, so the failure has to be on
  // the line — after the message it belongs to and before the tool's own verdict on it.
  it('prints why a skipped message was parked, then why it was skipped', () => {
    const line = lineFor(outcome.skipped.messageId);

    expect(line).toContain(`[parked: ${outcome.skipped.failedReason}]`);
    expect(line).toContain(outcome.skipped.detail);
    expect(line.indexOf(outcome.skipped.failedReason)).toBeGreaterThan(line.indexOf(outcome.skipped.messageId));
    expect(line.indexOf(outcome.skipped.detail)).toBeGreaterThan(line.indexOf(outcome.skipped.failedReason));
  });

  // A replayed message carries its reason too, but it is why the message was dead-lettered in the
  // first place — unlabelled it reads as a failure this run just produced.
  it('labels the reason on a replayed line as the one it was parked with', () => {
    const line = lineFor(outcome.replayed.messageId);

    expect(line).toContain(`[parked: ${outcome.replayed.failedReason}]`);
  });
});
