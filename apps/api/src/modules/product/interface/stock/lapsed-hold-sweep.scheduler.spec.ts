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

  it('refuses to build on a missing or out-of-range setting, even while disabled', () => {
    const invalid: Array<Record<string, unknown>> = [
      { 'inventory.holdSweep.intervalMs': undefined },
      { 'inventory.holdSweep.batchSize': undefined },
      { 'inventory.holdSweep.intervalMs': 0 },
      { 'inventory.holdSweep.enabled': false, 'inventory.holdSweep.batchSize': 0 },
    ];

    for (const overrides of invalid) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(
        /Invalid config: inventory\.holdSweep\./,
      );
    }
  });

  it('drives a sweep once the period elapses and stops with the module', async () => {
    const { make, registry, execute } = build();
    const scheduler = make();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.onModuleDestroy();

    expect(registry.addInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep', expect.anything());
    expect(execute).toHaveBeenCalledExactlyOnceWith({ batchSize: 50 });
    expect(registry.deleteInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep');
  });

  it('registers nothing at all when disabled', () => {
    const { make, registry } = build({ 'inventory.holdSweep.enabled': false });

    make().onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a tick while the previous one is still running', async () => {
    let finish = (): void => {};
    const execute = vi.fn().mockReturnValue(new Promise<LapsedHoldSweepSummary>((r) => (finish = () => r(IDLE))));
    const scheduler = build({}, execute).make();

    const first = scheduler.tick();
    await scheduler.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('escalates a full batch in which every release failed', async () => {
    const execute = vi.fn().mockResolvedValue({ scanned: 50, released: 0, raced: 0, errors: 50 });
    const { make, logger } = build({}, execute);

    await make().tick();

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stuck: true, errors: 50 }), expect.any(String));
  });

  it('does not escalate a full batch lost to races, which never come back', async () => {
    const execute = vi.fn().mockResolvedValue({ scanned: 50, released: 0, raced: 50, errors: 0 });
    const { make, logger } = build({}, execute);

    await make().tick();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ raced: 50 }), 'lapsed hold sweep completed');
  });

  it('swallows a sweep that throws and frees the guard for the next tick', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('pool exhausted')).mockResolvedValue(IDLE);
    const { make, logger } = build({}, execute);
    const scheduler = make();

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();

    await scheduler.tick();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
