import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import type { ShutdownService, ShutdownStep } from '@jcool/platform/health';
import { consumersOf, fakeDispatcher } from '../testing/fake-dispatcher';
import { CATALOG, ORDERS } from '../testing/messaging-fixtures';
import type { DeadLetterRouter } from './dead-letter';
import type { DomainEventProcessor } from './domain-event.processor';
import { DomainEventsWorker } from './domain-events.worker';

const redis = vi.hoisted(() => ({ quit: vi.fn<() => Promise<'OK'>>(), disconnect: vi.fn() }));
const workers = vi.hoisted(() => ({
  built: [] as { name: string; close: () => Promise<void>; fail: (job: unknown, error: Error) => void }[],
  close: (): Promise<void> => Promise.resolve(),
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class {
    private readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly close: () => Promise<void>;
    constructor(readonly name: string) {
      this.close = vi.fn(() => workers.close());
      workers.built.push({
        name,
        close: this.close,
        fail: (job, error) => this.listeners.get('failed')?.(job, error),
      });
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
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

const never = (): Promise<never> => new Promise(() => undefined);

describe('DomainEventsWorker shutdown step', () => {
  let route: ReturnType<typeof vi.fn<DeadLetterRouter['route']>>;
  let logger: { setContext: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    redis.quit.mockReset();
    redis.disconnect.mockReset();
    workers.built = [];
    workers.close = () => Promise.resolve();
    route = vi.fn(() => Promise.resolve());
    logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() };
  });
  afterEach(() => vi.useRealTimers());

  const closeStep = (queues = [ORDERS]): ShutdownStep => {
    const steps: ShutdownStep[] = [];
    const config = { get: (key: string) => CONFIG[key], getOrThrow: (key: string) => CONFIG[key] };
    const shutdown = { registerStep: (step: ShutdownStep) => steps.push(step) };
    const dispatcher = fakeDispatcher({});
    new DomainEventsWorker(
      {} as DomainEventProcessor,
      { route } as unknown as DeadLetterRouter,
      consumersOf(...queues.map((spec) => ({ spec, dispatcher }))),
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

  it('starts one worker per consumed queue on a single shared connection', () => {
    redis.quit.mockResolvedValue('OK');

    closeStep([ORDERS, CATALOG]);

    expect(workers.built.map(({ name }) => name)).toEqual(['orders', 'catalog']);
  });

  // In series, two stuck workers would cost 4 × 5s and outrun the platform's draining window.
  it('closes every worker at once, so two stuck ones cost one bounded wait, not two', async () => {
    redis.quit.mockResolvedValue('OK');
    workers.close = never;
    route.mockImplementation(never);
    const step = closeStep([ORDERS, CATALOG]);
    for (const worker of workers.built) worker.fail({ name: 'order.paid', data: {} }, new Error('boom'));
    let done = false;

    const running = step.run().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    for (const worker of workers.built) expect(worker.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(done).toBe(true);
  });

  it('logs a worker that fails to close and still closes the other', async () => {
    redis.quit.mockResolvedValue('OK');
    const step = closeStep([ORDERS, CATALOG]);
    vi.mocked(workers.built[0].close).mockRejectedValueOnce(new Error('redis gone'));

    await step.run();

    expect(workers.built[1].close).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'orders' }),
      'failed to close queue worker',
    );
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it('starts no worker and registers no step for a process that consumes nothing', () => {
    expect(closeStep([])).toBeUndefined();
    expect(workers.built).toEqual([]);
  });
});
