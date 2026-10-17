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
    for (const overrides of [{ 'inventory.holdSweep.intervalMs': 0 }, { 'inventory.holdSweep.batchSize': undefined }]) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(
        /Invalid config: inventory\.holdSweep\./,
      );
    }
  });

  it('sweeps one batch each period once the module starts', async () => {
    const { make, registry, execute } = build();

    make().onModuleInit();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(registry.addInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep', expect.anything());
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith({ batchSize: 50 });
  });

  it('registers no timer when disabled', async () => {
    const { make, registry, execute } = build({ 'inventory.holdSweep.enabled': false });

    make().onModuleInit();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('clears its timer when the module stops', () => {
    const { make, registry } = build();
    const scheduler = make();

    scheduler.onModuleInit();
    scheduler.onModuleDestroy();

    expect(registry.deleteInterval).toHaveBeenCalledWith('inventory-lapsed-hold-sweep');
  });

  it('skips a tick while the previous sweep is still running', async () => {
    let finish!: (summary: LapsedHoldSweepSummary) => void;
    const execute = vi.fn(() => new Promise<LapsedHoldSweepSummary>((resolve) => (finish = resolve)));
    const scheduler = build({}, execute).make();

    const first = scheduler.tick();
    await scheduler.tick();
    finish(IDLE);
    await first;

    expect(execute).toHaveBeenCalledTimes(1);
  });

  // An unhandled rejection in a timer callback would take the process down.
  it('logs a failed sweep instead of throwing it', async () => {
    const { make, logger } = build({}, vi.fn().mockRejectedValue(new Error('pool exhausted')));

    await expect(make().tick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('flags a full batch in which every release failed', async () => {
    const { make, logger } = build(
      {},
      vi.fn().mockResolvedValue({ scanned: 50, released: 0, raced: 0, errors: 50 } satisfies LapsedHoldSweepSummary),
    );

    await make().tick();

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stuck: true }), expect.any(String));
  });
});
