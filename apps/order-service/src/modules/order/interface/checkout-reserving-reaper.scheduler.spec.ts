import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { ReapReservingOrdersUseCase, ReapSummary } from '../application/use-cases';
import { CheckoutReservingReaperScheduler } from './checkout-reserving-reaper.scheduler';

const INTERVAL_MS = 60_000;
const IDLE: ReapSummary = { found: 0, handedBack: 0 };

function build(enabled = true, execute = vi.fn().mockResolvedValue(IDLE)) {
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduler = new CheckoutReservingReaperScheduler(
    { execute } as unknown as ReapReservingOrdersUseCase,
    fakeConfigService({ checkoutSaga: { reaper: { enabled, intervalMs: INTERVAL_MS } } }),
    registry as unknown as SchedulerRegistry,
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    fakePinoLogger(logger),
  );
  return { scheduler, registry, logger, execute };
}

describe('CheckoutReservingReaperScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps once the period elapses', async () => {
    const { scheduler, registry, execute } = build();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(registry.addInterval).toHaveBeenCalledWith('checkout-reserving-reaper', expect.anything());
    expect(execute).toHaveBeenCalledOnce();
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
    const execute = vi.fn(() => new Promise<ReapSummary>((resolve) => (finish = () => resolve(IDLE))));
    const { scheduler, logger } = build(true, execute);

    const first = scheduler.tick();
    await scheduler.tick();
    finish();
    await first;

    expect(execute).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  // An unhandled rejection in a timer would take the process down.
  it('logs a failed tick and keeps the schedule', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(IDLE);
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

    expect(registry.deleteInterval).toHaveBeenCalledWith('checkout-reserving-reaper');
  });
});
