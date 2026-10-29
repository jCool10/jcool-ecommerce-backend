import type { QueueOptions } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_PAID_BACKOFF } from '@jcool/internal-contracts/queues/order-events';
import { buildJobOptions, type ReplayOptions } from '@jcool/messaging';

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
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
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

vi.mock('@jcool/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jcool/messaging')>()),
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
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  const error = vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
  const argv = process.argv;

  const lineFor = (messageId: string): string => lines.find((line) => line.includes(messageId)) ?? '';
  const options = (name: string) => built.queues.find((queue) => queue.name === name)?.opts;

  async function runCli(...args: string[]): Promise<void> {
    built.queues = [];
    built.replayOptions = undefined;
    lines.length = 0;
    errors.length = 0;
    process.argv = [argv[0], 'replay-dlq.cli.ts', ...args];
    // The CLI reads its arguments at import, so every run needs a fresh copy of it.
    vi.resetModules();
    // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
    await import('./replay-dlq.cli.js');
    // `main()` is a floating promise the import does not await, and the summary is printed after it.
    for (let attempt = 0; attempt < 200 && errors.length === 0 && !lineFor(outcome.replayed.messageId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  beforeAll(() => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('QUEUE_CONSUMER_ATTEMPTS', String(ATTEMPTS));
    vi.stubEnv('QUEUE_CONSUMER_BACKOFF_MS', String(BACKOFF_MS));
    vi.stubEnv('ORDER_PAID_CONSUMER_ATTEMPTS', String(ORDER_PAID_ATTEMPTS));
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  afterAll(() => {
    process.argv = argv;
    log.mockRestore();
    error.mockRestore();
    vi.unstubAllEnvs();
  });

  // Replayed without the app's ladder, a message that already failed gets no retry budget. The DLQ
  // has no consumer, so retention defaults there would delete the record it exists to keep.
  it("replays on the app's retry ladders and keeps job defaults off the DLQ", async () => {
    await runCli('--queue', 'order-events');

    expect(options('order-events')?.defaultJobOptions).toEqual(buildJobOptions(ATTEMPTS, BACKOFF_MS));
    for (const eventType of ['order.paid', 'payment.authorized']) {
      expect(built.replayOptions?.jobOptionsFor(eventType), eventType).toEqual({
        attempts: ORDER_PAID_ATTEMPTS,
        backoff: { type: ORDER_PAID_BACKOFF },
      });
    }
    expect(options('order-events-dlq')).toBeDefined();
    expect(options('order-events-dlq')?.defaultJobOptions).toBeUndefined();
  });

  // Redis is the only other place the parked reason exists, and this tool runs when the app is broken.
  it('prints the labelled parked reason on each line, before the skip verdict', async () => {
    await runCli('--queue', 'order-events');
    const skipped = lineFor(outcome.skipped.messageId);

    expect(lineFor(outcome.replayed.messageId)).toContain(`[parked: ${outcome.replayed.failedReason}]`);
    expect(skipped).toContain(`[parked: ${outcome.skipped.failedReason}]`);
    expect(skipped.indexOf(outcome.skipped.failedReason)).toBeLessThan(skipped.indexOf(outcome.skipped.detail));
  });

  it.each([[[]], [['--queue', 'domain-events']]])(
    'exits non-zero and lists the valid queues for %j',
    async (args: string[]) => {
      await runCli(...args);

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('order-events, api-events');
      expect(built.queues).toEqual([]);
    },
  );

  it('drains api-events-dlq back onto api-events, on its own ladder', async () => {
    await runCli('--queue', 'api-events');

    expect(built.queues.map(({ name }) => name)).toEqual(['api-events', 'api-events-dlq']);
    expect(built.replayOptions?.jobOptionsFor('catalog.product.changed')).toEqual({
      attempts: ORDER_PAID_ATTEMPTS,
      backoff: { type: ORDER_PAID_BACKOFF },
    });
  });
});
