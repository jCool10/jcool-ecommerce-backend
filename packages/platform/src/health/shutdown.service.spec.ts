import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { SHUTDOWN_STEP_ORDER, ShutdownService } from './shutdown.service';

const noop = (): Promise<void> => Promise.resolve();

describe('ShutdownService', () => {
  afterEach(() => vi.useRealTimers());

  // Readiness must answer 503 for the whole grace window, so the flag cannot wait for the timer.
  it('flags shutdown at once and holds for the configured grace', async () => {
    vi.useFakeTimers();
    const service = new ShutdownService(fakeConfigService({ 'app.shutdownGracePeriodMs': 5000 }), fakePinoLogger());
    let settled = false;

    const pending = service.beforeApplicationShutdown('SIGTERM').then(() => {
      settled = true;
    });

    expect(service.isShuttingDown()).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  describe('steps', () => {
    it('runs steps after the hold, by ascending order regardless of registration order', async () => {
      vi.useFakeTimers();
      const service = new ShutdownService(fakeConfigService({ 'app.shutdownGracePeriodMs': 1000 }), fakePinoLogger());
      const ran: string[] = [];
      const record = (name: string) => (): Promise<void> => {
        ran.push(name);
        return Promise.resolve();
      };
      service.registerStep({ name: 'queue', order: SHUTDOWN_STEP_ORDER.CLOSE_QUEUE_WORKER, run: record('queue') });
      service.registerStep({
        name: 'workflow',
        order: SHUTDOWN_STEP_ORDER.DRAIN_WORKFLOW_WORKER,
        run: record('workflow'),
      });

      const pending = service.beforeApplicationShutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(999);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(ran).toEqual(['workflow', 'queue']);
    });

    it('waits for each step before starting the next', async () => {
      const service = new ShutdownService(fakeConfigService({}), fakePinoLogger());
      const events: string[] = [];
      let finishFirst!: () => void;
      service.registerStep({
        name: 'first',
        order: 1,
        run: () =>
          new Promise<void>((resolve) => {
            events.push('first started');
            finishFirst = () => {
              events.push('first done');
              resolve();
            };
          }),
      });
      service.registerStep({
        name: 'second',
        order: 2,
        run: () => {
          events.push('second started');
          return Promise.resolve();
        },
      });

      const pending = service.beforeApplicationShutdown();
      await vi.waitFor(() => expect(events).toEqual(['first started']));
      finishFirst();
      await pending;

      expect(events).toEqual(['first started', 'first done', 'second started']);
    });

    it('logs a throwing step and still runs the next one', async () => {
      const error = vi.fn();
      const info = vi.fn();
      const service = new ShutdownService(fakeConfigService({}), fakePinoLogger({ error, info }));
      const second = vi.fn(noop);
      service.registerStep({ name: 'broken', order: 1, run: () => Promise.reject(new Error('boom')) });
      service.registerStep({ name: 'second', order: 2, run: second });

      await expect(service.beforeApplicationShutdown()).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'broken', err: expect.objectContaining({ message: 'boom' }) as unknown }),
        'shutdown step failed',
      );
      expect(second).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'second', durationMs: expect.any(Number) as unknown }),
        'shutdown step done',
      );
    });

    it('rejects a second step under the same name', () => {
      const service = new ShutdownService(fakeConfigService({}), fakePinoLogger());
      service.registerStep({ name: 'queue', order: 1, run: noop });

      expect(() => service.registerStep({ name: 'queue', order: 2, run: noop })).toThrow(/queue/);
    });

    // Nest calls the hook on app.close() even when a test (or a signal handler) already did.
    it('returns the same promise on a second call and runs no step twice', async () => {
      const service = new ShutdownService(fakeConfigService({}), fakePinoLogger());
      const step = vi.fn(noop);
      service.registerStep({ name: 'queue', order: 1, run: step });

      const first = service.beforeApplicationShutdown('SIGTERM');
      const second = service.beforeApplicationShutdown();
      await Promise.all([first, second]);
      await service.beforeApplicationShutdown();

      expect(second).toBe(first);
      expect(step).toHaveBeenCalledOnce();
    });

    it('only flags and holds when no step is registered', async () => {
      vi.useFakeTimers();
      const info = vi.fn();
      const service = new ShutdownService(
        fakeConfigService({ 'app.shutdownGracePeriodMs': 500 }),
        fakePinoLogger({ info }),
      );

      const pending = service.beforeApplicationShutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(service.isShuttingDown()).toBe(true);
      expect(info).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(
        { signal: 'SIGTERM', gracePeriodMs: 500 },
        'shutdown signal received; /health/ready now returns 503',
      );
    });
  });
});
