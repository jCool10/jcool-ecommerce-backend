import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeadLetterStore, ReplayOptions } from './dead-letter.replay';

// Hoisted because the mock factories below run before this module's own initialisation.
const built = vi.hoisted(() => ({
  redisClients: 0,
  replayOptions: undefined as ReplayOptions | undefined,
}));

const outcome = vi.hoisted(() => ({
  skipped: {
    consumer: 'domain-events',
    messageId: '7300000000000000001',
    eventType: 'order.placed',
    status: 'skipped' as const,
    failedReason: 'error: connect ECONNREFUSED postgres:5432',
    detail: 'already applied at 2026-01-01T00:00:00.000Z, a replay would be a silent no-op',
  },
  replayed: {
    consumer: 'domain-events',
    messageId: '7300000000000000002',
    eventType: 'order.paid',
    status: 'replayed' as const,
    failedReason: 'TypeError: handler threw',
  },
}));

// The CLI runs `main()` on import, so every I/O client it could open is stubbed and the run is
// observed through the options it hands the replay.
vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      built.redisClients += 1;
    }
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
  replayDeadLetters: (_store: DeadLetterStore, options: ReplayOptions) => {
    built.replayOptions = options;
    return Promise.resolve({ replayed: 1, skipped: 1, outcomes: [outcome.skipped, outcome.replayed] });
  },
}));

describe('replay-dlq CLI', () => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  const argv = process.argv;

  const lineFor = (messageId: string): string => lines.find((line) => line.includes(messageId)) ?? '';

  beforeAll(async () => {
    process.argv = [argv[0], 'replay-dlq.cli.ts', '--consumer', 'domain-events', '--limit', '20'];
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('RETENTION_INBOX_DAYS', '30');
    // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
    await import('./replay-dlq.cli.js');
    // `main()` is a floating promise the import does not await, and the summary is printed after it.
    for (let attempt = 0; attempt < 200 && !lineFor(outcome.replayed.messageId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  afterAll(() => {
    process.argv = argv;
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  // Dead letters live in Postgres now, and this tool runs when the app is what is broken.
  it('reads dead letters from Postgres alone, for the consumer and batch asked for', () => {
    expect(built.redisClients).toBe(0);
    expect(built.replayOptions).toMatchObject({
      consumer: 'domain-events',
      limit: 20,
      dryRun: true,
      force: false,
      inboxRetentionMs: 30 * 86_400_000,
    });
  });

  it('prints the labelled parked reason on each line, before the skip verdict', () => {
    const skipped = lineFor(outcome.skipped.messageId);

    expect(lineFor(outcome.replayed.messageId)).toContain(`[parked: ${outcome.replayed.failedReason}]`);
    expect(skipped).toContain(`[parked: ${outcome.skipped.failedReason}]`);
    expect(skipped.indexOf(outcome.skipped.failedReason)).toBeLessThan(skipped.indexOf(outcome.skipped.detail));
  });
});
