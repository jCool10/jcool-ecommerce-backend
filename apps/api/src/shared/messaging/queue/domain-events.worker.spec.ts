import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import type { ShutdownService, ShutdownStep } from '@jcool/platform/health';
import type { DeadLetterRouter } from './dead-letter';
import type { DomainEventProcessor } from './domain-event.processor';
import { DomainEventsWorker } from './domain-events.worker';

const redis = vi.hoisted(() => ({ quit: vi.fn<() => Promise<'OK'>>(), disconnect: vi.fn() }));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class {
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('./queue-connection', () => ({ createQueueConnection: () => redis }));

const CONFIG: Record<string, unknown> = {
  'queue.workerEnabled': true,
  'queue.workerConcurrency': 2,
  'queue.prefix': 'jcool',
  'redis.url': 'redis://127.0.0.1:6379',
  'queue.consumerBackoffMs': 100,
  'queue.orderPaidBackoffCapMs': 1000,
};

describe('DomainEventsWorker shutdown step', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    redis.quit.mockReset();
    redis.disconnect.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const closeStep = (): ShutdownStep => {
    const steps: ShutdownStep[] = [];
    const config = { get: (key: string) => CONFIG[key], getOrThrow: (key: string) => CONFIG[key] };
    const shutdown = { registerStep: (step: ShutdownStep) => steps.push(step) };
    const logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() };
    new DomainEventsWorker(
      {} as DomainEventProcessor,
      {} as DeadLetterRouter,
      config as unknown as ConfigService,
      {} as ClsService,
      shutdown as unknown as ShutdownService,
      logger as unknown as PinoLogger,
    ).onModuleInit();
    return steps[0];
  };

  it('quits the queue connection when Redis answers', async () => {
    redis.quit.mockResolvedValue('OK');

    await closeStep().run();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects when Redis is already gone', async () => {
    redis.quit.mockRejectedValue(new Error('Connection is closed.'));

    await closeStep().run();

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects after a second instead of waiting on a quit stuck behind the offline queue', async () => {
    redis.quit.mockReturnValue(new Promise(() => undefined));
    let done = false;
    const step = closeStep()
      .run()
      .then(() => (done = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await step;

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
