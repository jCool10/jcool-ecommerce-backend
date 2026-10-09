import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { CheckoutSagaRepositoryPort } from '../application/ports/checkout-saga-repository.port';
import type { AdvanceCheckoutSagaUseCase } from '../application/use-cases/advance-checkout-saga.use-case';
import { CheckoutSagaRunnerScheduler } from './checkout-saga-runner.scheduler';

const CONFIG: Record<string, unknown> = {
  'saga.runnerEnabled': true,
  'saga.runnerIntervalMs': 5_000,
  'saga.runnerBatchSize': 3,
};

function build(overrides: Record<string, unknown> = {}) {
  const sagas = { findDue: vi.fn().mockResolvedValue(['900001', '900002', '900003']) };
  const execute = vi.fn((_orderId: string) => Promise.resolve(undefined));
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new CheckoutSagaRunnerScheduler(
      sagas as unknown as CheckoutSagaRepositoryPort,
      { execute } as unknown as AdvanceCheckoutSagaUseCase,
      fakeConfigService({ ...CONFIG, ...overrides }),
      registry as unknown as SchedulerRegistry,
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger(logger),
    );
  return { make, sagas, execute, registry, logger };
}

describe('CheckoutSagaRunnerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to build on a missing or out-of-range setting, even while disabled', () => {
    const invalid: Array<Record<string, unknown>> = [
      { 'saga.runnerIntervalMs': undefined },
      { 'saga.runnerBatchSize': undefined },
      { 'saga.runnerIntervalMs': 0 },
      { 'saga.runnerEnabled': false, 'saga.runnerBatchSize': 0 },
    ];

    for (const overrides of invalid) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(/Invalid config: saga\./);
    }
  });

  it('starts no timer while disabled', () => {
    const { make, registry } = build({ 'saga.runnerEnabled': false });

    make().onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
  });

  it('ticks once the interval elapses', async () => {
    const { make, sagas } = build();

    make().onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sagas.findDue).toHaveBeenCalledWith(3);
  });

  it('only reads the due sagas and advances them one after another', async () => {
    const { make, sagas, execute } = build();
    const order: string[] = [];
    execute.mockImplementation(async (id) => {
      order.push(`start ${id}`);
      await Promise.resolve();
      order.push(`end ${id}`);
    });

    await make().tick();

    expect(Object.keys(sagas)).toEqual(['findDue']);
    expect(order).toEqual(['start 900001', 'end 900001', 'start 900002', 'end 900002', 'start 900003', 'end 900003']);
  });

  it('keeps going past an advance that throws', async () => {
    const { make, execute, logger } = build();
    execute.mockRejectedValueOnce(new Error('db gone'));

    await make().tick();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: '900001', err: expect.any(Error) as unknown }),
      expect.any(String),
    );
  });

  it('swallows a failed read so the timer survives it', async () => {
    const { make, sagas, logger } = build();
    sagas.findDue.mockRejectedValueOnce(new Error('db gone'));

    await expect(make().tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('skips a tick while the previous one is still running', async () => {
    const { make, sagas, execute } = build();
    let finish!: () => void;
    execute.mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    const scheduler = make();

    const first = scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.tick();
    finish();
    await first;

    expect(sagas.findDue).toHaveBeenCalledTimes(1);
  });

  describe('shutdown', () => {
    it('clears the timer and advances nothing more from the batch in hand', async () => {
      const { make, execute, registry } = build();
      let finish!: () => void;
      execute.mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
      const scheduler = make();

      const tick = scheduler.tick();
      await vi.advanceTimersByTimeAsync(0);
      const closing = scheduler.onModuleDestroy();
      finish();
      await Promise.all([tick, closing]);

      expect(registry.deleteInterval).toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('stops waiting on a tick that never finishes after a bounded wait', async () => {
      const { make, execute } = build();
      execute.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
      const scheduler = make();
      void scheduler.tick();
      await vi.advanceTimersByTimeAsync(0);
      let closed = false;

      const closing = scheduler.onModuleDestroy().then(() => (closed = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(closed).toBe(true);
    });
  });
});
