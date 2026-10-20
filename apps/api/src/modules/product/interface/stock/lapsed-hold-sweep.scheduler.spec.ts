import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type {
  LapsedHoldSweepSummary,
  ReleaseLapsedHoldsUseCase,
} from '../../application/stock/release-lapsed-holds.use-case';
import { LapsedHoldSweepScheduler } from './lapsed-hold-sweep.scheduler';

const CONFIG: Record<string, unknown> = {
  'inventory.holdSweep.enabled': true,
  'inventory.holdSweep.intervalMs': 60_000,
  'inventory.holdSweep.batchSize': 50,
};

const IDLE: LapsedHoldSweepSummary = { scanned: 0, released: 0, raced: 0, errors: 0 };

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new LapsedHoldSweepScheduler(
      { execute } as unknown as ReleaseLapsedHoldsUseCase,
      fakeConfigService({ ...CONFIG, ...overrides }),
      registry as unknown as SchedulerRegistry,
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger(logger),
    );
  return { make, registry, logger, execute };
}

describe('LapsedHoldSweepScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to build on a missing or out-of-range setting', () => {
    for (const overrides of [
      { 'inventory.holdSweep.intervalMs': undefined },
      { 'inventory.holdSweep.intervalMs': 0 },
      { 'inventory.holdSweep.batchSize': 0 },
    ]) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(
        /Invalid config: inventory\.holdSweep\./,
      );
    }
  });

  it('drives a sweep once the period elapses and stops on module destroy', async () => {
    const { make, registry, execute } = build();
    const scheduler = make();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.onModuleDestroy();

    expect(registry.addInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep', expect.anything());
    expect(execute).toHaveBeenCalledWith({ batchSize: 50 });
    expect(registry.deleteInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep');
  });

  it('registers nothing when disabled', () => {
    const { make, registry } = build({ 'inventory.holdSweep.enabled': false });

    make().onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a tick while the previous one is still running', async () => {
    let finish!: (summary: LapsedHoldSweepSummary) => void;
    const execute = vi.fn(() => new Promise<LapsedHoldSweepSummary>((resolve) => (finish = resolve)));
    const { make, logger } = build({}, execute);
    const scheduler = make();

    const first = scheduler.tick();
    await scheduler.tick();
    finish(IDLE);
    await first;

    expect(execute).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  // An unhandled rejection from a timer callback takes the process down.
  it('swallows a failed sweep and logs it', async () => {
    const { make, logger } = build({}, vi.fn().mockRejectedValue(new Error('connection terminated')));

    await expect(make().tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
