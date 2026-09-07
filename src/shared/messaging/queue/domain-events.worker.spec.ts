import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DeadLetterRouter } from './dead-letter';
import type { DomainEventProcessor } from './domain-event.processor';
import { DomainEventsWorker } from './domain-events.worker';

const CONFIG: Record<string, unknown> = {
  'queue.workerEnabled': false,
  'queue.workerConcurrency': 5,
  'queue.prefix': 'test',
  'redis.url': 'redis://127.0.0.1:6379',
};

function build(overrides: Record<string, unknown> = {}) {
  const values = { ...CONFIG, ...overrides };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`Missing config ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
  const logger = { info: vi.fn(), error: vi.fn() };

  const worker = new DomainEventsWorker(
    { process: vi.fn() } as unknown as DomainEventProcessor,
    { route: vi.fn() } as unknown as DeadLetterRouter,
    config,
    // Pass-through: correlation is asserted in job-context.spec.ts.
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    logger as unknown as PinoLogger,
  );
  return { worker, logger };
}

/**
 * Only the disabled path and the config contract: anything past an enabled `onModuleInit` opens a
 * real Redis connection and belongs to the e2e suite, which runs a genuine worker against a
 * container.
 */
describe('DomainEventsWorker', () => {
  it('reads its config at construction, so a missing key fails at boot rather than on first job', () => {
    expect(() => build({ 'queue.prefix': undefined })).toThrow(/Missing config queue.prefix/);
  });

  it('opens no connection while disabled', async () => {
    const { worker, logger } = build();

    worker.onModuleInit();

    expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'domain events worker disabled');
    // Shutdown of a worker that never started must stay a no-op — with the deploy default off, this
    // is the path every process without QUEUE_WORKER_ENABLED takes on SIGTERM.
    await expect(worker.beforeApplicationShutdown()).resolves.toBeUndefined();
  });

  it('treats anything but a true boolean as disabled', () => {
    const { worker, logger } = build({ 'queue.workerEnabled': 'true' });

    worker.onModuleInit();

    expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'domain events worker disabled');
  });
});
