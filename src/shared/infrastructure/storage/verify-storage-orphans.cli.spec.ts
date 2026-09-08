import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted because the mock factories below run before this module's own initialisation. The CLI runs
// `main()` on import, so the scenario is staged here and every I/O client it opens is stubbed.
const scenario = vi.hoisted(() => ({
  /** What the first, unfiltered `media_assets` select returns — the snapshot taken before listing. */
  snapshotRows: [] as { id: string; storageKey: string; status: string }[],
  /** Keys the nth re-check select finds; indexed by call, so per-chunk answers stay distinguishable. */
  recheckResults: [] as string[][],
  recheckCalls: 0,
  /** Every value list bound to `inArray` — the parameter count Postgres actually refuses. */
  recheckBindings: [] as string[][],
  /** One ListObjectsV2 response per entry; every page but the last reports IsTruncated. */
  bucketPages: [] as string[][],
}));

// Only `inArray` is replaced, and only to record what it was handed: the builder below throws its
// `where` argument away, so nothing else can tell a chunked bind from one that re-sends every key.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: (column: unknown, values: string[]) => {
      scenario.recheckBindings.push([...values]);
      return actual.inArray(column as never, values);
    },
  };
});

vi.mock('pg', () => ({
  Pool: class {
    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

// A thenable builder rather than a query runner: the three selects the CLI issues are told apart by
// their shape — `leftJoin` is only the dangling-link join, `where` alone is only the orphan re-check.
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => {
        let joined = false;
        let filtered = false;
        const rows = (): unknown[] => {
          if (joined) return [];
          if (!filtered) return scenario.snapshotRows;
          const found = scenario.recheckResults[scenario.recheckCalls] ?? [];
          scenario.recheckCalls += 1;
          return found.map((storageKey) => ({ storageKey }));
        };
        const builder = {
          leftJoin: () => {
            joined = true;
            return builder;
          },
          where: () => {
            filtered = true;
            return builder;
          },
          then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(rows).then(resolve, reject),
        };
        return builder;
      },
    }),
  }),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class ListObjectsV2Command {
    constructor(readonly input: { ContinuationToken?: string }) {}
  }
  class HeadObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  return {
    ListObjectsV2Command,
    HeadObjectCommand,
    S3Client: class {
      send(command: unknown): Promise<unknown> {
        if (command instanceof ListObjectsV2Command) {
          const index = Number(command.input.ContinuationToken ?? '0');
          const keys = scenario.bucketPages[index] ?? [];
          const truncated = index + 1 < scenario.bucketPages.length;
          return Promise.resolve({
            Contents: keys.map((Key) => ({ Key })),
            IsTruncated: truncated,
            NextContinuationToken: truncated ? String(index + 1) : undefined,
          });
        }
        return Promise.resolve({});
      }
      destroy(): void {}
    },
  };
});

const logged: string[] = [];
const errored: string[] = [];
const originalExitCode = process.exitCode;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`CLI never finished. stderr: ${errored.join(' | ') || '(none)'}`);
}

/** `main()` runs on import, so a scenario is one module evaluation; the registry reset gives the next one. */
async function runCli(): Promise<{ lines: string[]; exitCode: typeof process.exitCode }> {
  scenario.recheckCalls = 0;
  scenario.recheckBindings.length = 0;
  logged.length = 0;
  errored.length = 0;
  process.exitCode = 0;
  vi.resetModules();
  // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
  await import('./verify-storage-orphans.cli.js');
  await waitFor(() => logged.some((line) => line.startsWith('\ndangling links')));
  const exitCode = process.exitCode;
  // Restored immediately: a scenario that legitimately reports findings would otherwise fail the run.
  process.exitCode = 0;
  return { lines: [...logged], exitCode };
}

function orphanCount(lines: string[]): number {
  const header = lines.find((line) => line.startsWith('\norphan objects'));
  return Number(header?.split(': ').at(-1));
}

describe('verify-storage-orphans CLI', () => {
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errored.push(String(line)));

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
    process.env.STORAGE_BUCKET = 'test-bucket';
    process.env.STORAGE_ACCESS_KEY_ID = 'key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'secret';
  });

  afterAll(() => {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = originalExitCode;
  });

  // The row snapshot predates the listing and an upload inserts its row before it PUTs, so a key that
  // appeared mid-scan is missing from the snapshot while being a healthy asset. Reporting it would
  // fail a scheduled run over an upload that was working correctly.
  it('does not report a key whose row appeared after the snapshot', async () => {
    scenario.snapshotRows = [];
    scenario.bucketPages = [['media/landed-mid-scan.png']];
    scenario.recheckResults = [['media/landed-mid-scan.png']];

    const { lines, exitCode } = await runCli();

    expect(orphanCount(lines)).toBe(0);
    expect(lines.some((line) => line.includes('media/landed-mid-scan.png'))).toBe(false);
    expect(exitCode).not.toBe(1);
  });

  // The re-check binds a parameter per candidate, so a listing larger than one statement can hold
  // must be split — and every chunk's answer counted, not just the last one's.
  it('re-checks candidates in chunks and keeps what each chunk found', async () => {
    const keys = Array.from({ length: 2001 }, (_, index) => `media/object-${index}.png`);
    scenario.snapshotRows = [];
    scenario.bucketPages = [keys.slice(0, 1000), keys.slice(1000, 2000), keys.slice(2000)];
    // One hit per chunk, each only reachable if that chunk was queried and its result kept.
    scenario.recheckResults = [[keys[0]], [keys[1000]], [keys[2000]]];

    const { lines } = await runCli();

    expect(scenario.recheckCalls).toBe(3);
    // The decisive assertion: three statements that each re-sent all 2001 keys would satisfy every
    // other expectation here while still overrunning the bind-parameter limit.
    expect(scenario.recheckBindings.map((values) => values.length)).toEqual([1000, 1000, 1]);
    expect(scenario.recheckBindings.flat()).toEqual(keys);
    expect(orphanCount(lines)).toBe(keys.length - 3);
    for (const found of [keys[0], keys[1000], keys[2000]]) {
      expect(lines.some((line) => line.trim() === found)).toBe(false);
    }
  });
});
