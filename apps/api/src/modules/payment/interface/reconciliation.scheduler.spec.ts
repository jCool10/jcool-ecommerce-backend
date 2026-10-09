import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileTccPaymentsUseCase, ReconcileTccSummary } from '../application/use-cases';
import { ReconciliationScheduler } from './reconciliation.scheduler';

const CONFIG: Record<string, unknown> = {
  'reconcile.enabled': true,
  'reconcile.intervalMs': 60_000,
  'reconcile.staleAfterSec': 120,
  'reconcile.batchSize': 50,
};

const IDLE: ReconcileTccSummary = {
  scanned: 0,
  authorized: 0,
  expired: 0,
  voided: 0,
  undecided: 0,
  skipped: 0,
  conflicts: 0,
  errors: 0,
};

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const error = vi.fn();
  const make = () =>
    new ReconciliationScheduler(
      { execute } as unknown as ReconcileTccPaymentsUseCase,
      fakeConfigService({ ...CONFIG, ...overrides }),
      registry as unknown as SchedulerRegistry,
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger({ error }),
    );
  return { make, registry, error, execute };
}

describe('ReconciliationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // An undefined interval fires every event-loop turn, a busy loop against the gateway.
  it('refuses to build on a missing or out-of-range setting, even while disabled', () => {
    const invalid: Array<Record<string, unknown>> = [
      { 'reconcile.intervalMs': undefined },
      { 'reconcile.batchSize': undefined },
      { 'reconcile.staleAfterSec': undefined },
      { 'reconcile.intervalMs': 0 },
      { 'reconcile.enabled': false, 'reconcile.batchSize': -1 },
    ];

    for (const overrides of invalid) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(/Invalid config: reconcile\./);
    }
  });

  it('registers one timer that reconciles the TCC payments once the period elapses', async () => {
    const { make, registry, execute } = build();

    make().onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(registry.addInterval).toHaveBeenCalledWith('payment-reconcile-tcc', expect.anything());
    expect(vi.getTimerCount()).toBe(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ staleAfterSec: 120, batchSize: 50 });
  });

  it('registers nothing at all when disabled', () => {
    const { make, registry } = build({ 'reconcile.enabled': false });

    make().onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a tick while the previous sweep is still working', async () => {
    let release: () => void = () => {};
    const execute = vi.fn(() => new Promise<ReconcileTccSummary>((resolve) => (release = () => resolve(IDLE))));
    const scheduler = build({}, execute).make();

    const first = scheduler.tick();
    await scheduler.tick();

    expect(execute).toHaveBeenCalledOnce();
    release();
    await first;
  });

  // An unhandled rejection inside a timer callback takes the process down with it.
  it('swallows a sweep failure and frees the guard for the next tick', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('payments query failed'));
    const { make, error } = build({}, execute);
    const scheduler = make();

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();

    await scheduler.tick();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
