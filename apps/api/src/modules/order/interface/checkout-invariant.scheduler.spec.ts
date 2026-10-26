import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { CheckoutInvariantRun, RunCheckoutInvariantsUseCase } from '../application/use-cases';
import { CheckoutInvariantScheduler } from './checkout-invariant.scheduler';

const INTERVAL_MS = 60_000;
const CLEAN: CheckoutInvariantRun = {
  result: 'ok',
  checked: 3,
  violations: {
    captured_without_paid: 0,
    paid_without_capture: 0,
    paid_without_commit: 0,
    orphan_hold: 0,
    authorized_on_dead_order: 0,
  },
};

function build(enabled = true, execute = vi.fn().mockResolvedValue(CLEAN)) {
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduler = new CheckoutInvariantScheduler(
    { execute } as unknown as RunCheckoutInvariantsUseCase,
    fakeConfigService({ checkoutSaga: { invariant: { enabled, intervalMs: INTERVAL_MS } } }),
    registry as unknown as SchedulerRegistry,
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    fakePinoLogger(logger),
  );
  return { scheduler, registry, logger, execute };
}

describe('CheckoutInvariantScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks once the period elapses and logs how the run went', async () => {
    const { scheduler, registry, execute, logger } = build();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(registry.addInterval).toHaveBeenCalledWith('checkout-invariant-checker', expect.anything());
    expect(execute).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenLastCalledWith({ result: 'ok', checked: 3 }, expect.any(String));
  });

  it('starts no timer when disabled', async () => {
    const { scheduler, registry, execute } = build(false);

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous one is still running', async () => {
    let finish!: () => void;
    const execute = vi.fn(() => new Promise<CheckoutInvariantRun>((resolve) => (finish = () => resolve(CLEAN))));
    const { scheduler, logger } = build(true, execute);

    const first = scheduler.tick();
    await scheduler.tick();
    finish();
    await first;

    expect(execute).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('logs a failed tick and keeps the schedule', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(CLEAN);
    const { scheduler, logger } = build(true, execute);

    await scheduler.tick();
    await scheduler.tick();

    expect(logger.error).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('clears its timer on shutdown', () => {
    const { scheduler, registry } = build();

    scheduler.onModuleInit();
    scheduler.onModuleDestroy();

    expect(registry.deleteInterval).toHaveBeenCalledWith('checkout-invariant-checker');
  });
});
