import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { PinoLogger } from 'nestjs-pino';
import { SHUTDOWN_STEP_ORDER, type ShutdownService, type ShutdownStep } from '@jcool/platform/health';
import type { CheckoutSagaActivities } from './checkout-saga.activities';
import { CheckoutSagaWorker, workerBackoffMs } from './checkout-saga.worker';
import { installTemporalRuntime } from './temporal-runtime';
import { checkoutSagaWorkflowsPath } from './workflow-bundle';

vi.mock('./temporal-runtime', () => ({ installTemporalRuntime: vi.fn() }));
// So the production cases do not depend on whether a local build left a bundle in dist.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(fs.existsSync) };
});

const BUILT_BUNDLE = resolve('dist/workflows/checkout-saga.bundle.js');

const GRACE_MS = 400;
const FORCE_MS = 600;

const settings = (temporal: Record<string, unknown> = {}) => ({
  activityConcurrency: 3,
  localActivityConcurrency: 4,
  temporal: {
    address: '127.0.0.1:7233',
    namespace: 'jcool',
    taskQueue: 'checkout-saga',
    workerEnabled: true,
    workerShutdownGraceMs: GRACE_MS,
    workerShutdownForceMs: FORCE_MS,
    workflowBundlePath: '/tmp/checkout-saga.bundle.js',
    ...temporal,
  },
});

// Stands in for the SDK worker: run() stays pending until the test finishes or crashes it.
const fakeWorker = () => {
  let state = 'INITIALIZED';
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const worker = {
    run: vi.fn(() => {
      state = 'RUNNING';
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
    }),
    shutdown: vi.fn(() => {
      state = 'STOPPING';
    }),
    getState: () => state,
    getStatus: () => ({ numInFlightActivities: 3, numInFlightNonLocalActivities: 2, numInFlightLocalActivities: 1 }),
  };
  return {
    worker,
    finish: () => {
      state = 'STOPPED';
      settle?.resolve();
    },
    crash: (error: Error) => {
      state = 'FAILED';
      settle?.reject(error);
    },
  };
};

describe('CheckoutSagaWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(installTemporalRuntime).mockClear();
  });

  const build = (options: { config?: ReturnType<typeof settings>; env?: string } = {}) => {
    const config = {
      getOrThrow: vi.fn(() => options.config ?? settings()),
      get: vi.fn(() => options.env ?? 'test'),
    };
    const steps: ShutdownStep[] = [];
    const shutdown = { registerStep: vi.fn((step: ShutdownStep) => steps.push(step)) };
    const logger = { setContext: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const activities = { commitStock: vi.fn() } as unknown as CheckoutSagaActivities;
    const connection = { close: vi.fn(() => Promise.resolve()) };
    const connect = vi.spyOn(NativeConnection, 'connect').mockResolvedValue(connection as never);
    const workers = [fakeWorker(), fakeWorker(), fakeWorker()];
    const create = vi.spyOn(Worker, 'create');
    for (const { worker } of workers) create.mockResolvedValueOnce(worker as never);

    const supervisor = new CheckoutSagaWorker(
      activities,
      config as unknown as ConfigService,
      shutdown as unknown as ShutdownService,
      logger as unknown as PinoLogger,
    );
    const boot = async () => {
      supervisor.onModuleInit();
      supervisor.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
    };
    const runShutdownStep = () => steps[0].run();
    return { supervisor, boot, runShutdownStep, steps, logger, activities, connection, connect, create, workers };
  };

  it('does nothing when disabled and says so in its status', async () => {
    const { supervisor, boot, steps, connect } = build({ config: settings({ workerEnabled: false }) });

    await boot();

    expect(supervisor.status()).toEqual({ state: 'DISABLED', inFlightActivities: 0, inFlightLocalActivities: 0 });
    expect(steps).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(installTemporalRuntime).not.toHaveBeenCalled();
  });

  it('installs the runtime and registers its drain ahead of the queue worker', () => {
    const { supervisor, steps } = build();

    supervisor.onModuleInit();

    expect(installTemporalRuntime).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([
      expect.objectContaining({ name: 'temporal-worker', order: SHUTDOWN_STEP_ORDER.DRAIN_WORKFLOW_WORKER }),
    ]);
  });

  it('boots without waiting for Temporal', () => {
    const { supervisor, connect } = build();
    connect.mockReturnValue(new Promise(() => undefined));

    supervisor.onModuleInit();
    expect(supervisor.onApplicationBootstrap()).toBeUndefined();
    expect(supervisor.status().state).toBe('CONNECTING');
  });

  it('runs a worker on the configured queue with both activity pools and the shutdown budget', async () => {
    const { supervisor, boot, activities, connection, connect, create } = build();

    await boot();

    expect(connect).toHaveBeenCalledWith({ address: '127.0.0.1:7233' });
    expect(create).toHaveBeenCalledWith({
      connection,
      namespace: 'jcool',
      taskQueue: 'checkout-saga',
      workflowBundle: { codePath: '/tmp/checkout-saga.bundle.js' },
      activities,
      maxConcurrentActivityTaskExecutions: 3,
      maxConcurrentLocalActivityExecutions: 4,
      shutdownGraceTime: GRACE_MS,
      shutdownForceTime: GRACE_MS + FORCE_MS,
    });
    expect(supervisor.status()).toEqual({ state: 'RUNNING', inFlightActivities: 2, inFlightLocalActivities: 1 });
  });

  it('bundles the TypeScript sources outside production when no bundle is given', async () => {
    const { boot, create } = build({ config: settings({ workflowBundlePath: undefined }) });

    await boot();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workflowsPath: checkoutSagaWorkflowsPath() }));
  });

  it('runs the bundle built into dist in production', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    const { boot, create } = build({ config: settings({ workflowBundlePath: undefined }), env: 'production' });

    await boot();

    expect(existsSync).toHaveBeenCalledWith(BUILT_BUNDLE);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workflowBundle: { codePath: BUILT_BUNDLE } }));
  });

  it('backs off and logs an error in production when the built bundle is missing', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const { supervisor, boot, connect, logger } = build({
      config: settings({ workflowBundlePath: undefined }),
      env: 'production',
    });

    await boot();

    expect(supervisor.status().state).toBe('BACKOFF');
    expect(connect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ bundle: BUILT_BUNDLE }), expect.any(String));
  });

  it('retries a failed connect with growing backoff, warning at most once a minute', async () => {
    const { supervisor, boot, connect, create, logger } = build();
    connect.mockRejectedValueOnce(new Error('connection refused'));
    connect.mockRejectedValueOnce(new Error('connection refused'));

    await boot();
    expect(supervisor.status().state).toBe('BACKOFF');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(supervisor.status().state).toBe('RUNNING');
  });

  it('reconnects after the worker dies on its own, closing the old connection first', async () => {
    const { supervisor, boot, workers, connect, connection, logger } = build();
    await boot();

    workers[0].crash(new Error('fatal poller error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.status().state).toBe('BACKOFF');
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.status().state).toBe('RUNNING');
  });

  it('starts the backoff over once a worker has run', async () => {
    const { boot, workers, connect } = build();
    connect.mockRejectedValueOnce(new Error('down'));
    await boot();
    await vi.advanceTimersByTimeAsync(1000);

    workers[0].crash(new Error('fatal poller error'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(connect).toHaveBeenCalledTimes(3);
  });

  describe('shutdown step', () => {
    it('drains the running worker, then closes its connection', async () => {
      const { supervisor, boot, runShutdownStep, workers, connection } = build();
      await boot();

      const step = runShutdownStep();
      expect(workers[0].worker.shutdown).toHaveBeenCalledTimes(1);
      expect(supervisor.status().state).toBe('STOPPING');
      expect(connection.close).not.toHaveBeenCalled();

      workers[0].finish();
      await step;

      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(supervisor.status().state).toBe('STOPPED');
    });

    it('gives up waiting after grace + force + 1s and only logs a close that fails', async () => {
      const { boot, runShutdownStep, connection, logger } = build();
      connection.close.mockRejectedValue(new Error('Cannot close connection while Workers hold a reference to it'));
      await boot();

      let done = false;
      const step = runShutdownStep().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(GRACE_MS + FORCE_MS + 999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await step;

      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('close'));
    });

    it('only logs a run that rejects once shutdown was asked for', async () => {
      const { supervisor, boot, runShutdownStep, workers, logger } = build();
      await boot();

      const step = runShutdownStep();
      workers[0].crash(new Error('Timed out while waiting for worker to shutdown gracefully'));
      await expect(step).resolves.toBeUndefined();

      expect(supervisor.status().state).toBe('STOPPED');
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('shutdown'));
    });

    it('cuts a backoff short and never reconnects', async () => {
      const { supervisor, boot, runShutdownStep, connect } = build();
      connect.mockRejectedValueOnce(new Error('down'));
      await boot();

      await runShutdownStep();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(supervisor.status().state).toBe('STOPPED');
    });

    it('stops a worker that was still being created, without leaving it polling', async () => {
      const { supervisor, boot, runShutdownStep, create, workers, connection } = build();
      let created!: (worker: never) => void;
      create.mockReset().mockReturnValueOnce(new Promise((resolve) => (created = resolve)));
      await boot();

      const step = runShutdownStep();
      created(workers[0].worker as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(workers[0].worker.shutdown).toHaveBeenCalledTimes(1);

      workers[0].finish();
      await step;
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(supervisor.status().state).toBe('STOPPED');
    });
  });
});

describe('workerBackoffMs', () => {
  it.each([
    [0, 0.5, 1000],
    [1, 0.5, 2000],
    [4, 0.5, 16_000],
    [5, 0.5, 30_000],
    [30, 0.5, 30_000],
    [3, 0, 6400],
    [3, 1, 9600],
    [0, 0, 1000],
    [10, 1, 30_000],
  ])('after %i failures with random %d waits %i ms', (failures, random, expected) => {
    expect(workerBackoffMs(failures, () => random)).toBe(expected);
  });
});
