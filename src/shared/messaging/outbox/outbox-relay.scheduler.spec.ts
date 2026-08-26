import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxRelay, RelayTickSummary } from './outbox-relay';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';

const CONFIG: Record<string, unknown> = {
  'outbox.relayEnabled': true,
  'outbox.pollMs': 1_000,
  'outbox.batchSize': 100,
};

const IDLE: RelayTickSummary = { published: 0, failed: 0 };

function build(overrides: Record<string, unknown> = {}, runOnce = vi.fn().mockResolvedValue(IDLE)) {
  const values = { ...CONFIG, ...overrides };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new OutboxRelayScheduler(
      { runOnce } as unknown as OutboxRelay,
      config,
      registry as unknown as SchedulerRegistry,
      logger as unknown as PinoLogger,
    );
  return { make, registry, logger, runOnce };
}

describe('OutboxRelayScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it.each(['outbox.pollMs', 'outbox.batchSize'])('refuses to build when %s is missing', (key) => {
      expect(() => build({ [key]: undefined }).make()).toThrow(/Invalid outbox relay config/);
    });

    it('refuses a zero interval, which would poll the outbox every event-loop turn', () => {
      expect(() => build({ 'outbox.pollMs': 0 }).make()).toThrow(/Invalid outbox relay config/);
    });

    it('validates config even while disabled, so a typo surfaces at boot and not on first enable', () => {
      expect(() => build({ 'outbox.relayEnabled': false, 'outbox.batchSize': -1 }).make()).toThrow(
        /Invalid outbox relay config/,
      );
    });
  });

  describe('onModuleInit', () => {
    it('registers a timer at the configured period', () => {
      const { make, registry } = build();

      const scheduler = make();
      scheduler.onModuleInit();

      expect(registry.addInterval).toHaveBeenCalledWith('messaging-outbox-relay', expect.anything());
      expect(vi.getTimerCount()).toBe(1);
      return scheduler.onModuleDestroy();
    });

    it('drives a tick at the configured batch size once the period elapses', async () => {
      const { make, runOnce } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runOnce).toHaveBeenCalledWith(100);
      await scheduler.onModuleDestroy();
    });

    it('registers nothing at all when disabled', () => {
      const { make, registry, logger } = build({ 'outbox.relayEnabled': false });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'outbox relay disabled');
    });
  });

  describe('tick', () => {
    it('skips a tick while the previous one is still working', async () => {
      let release: () => void = () => {};
      const runOnce = vi.fn(() => new Promise<RelayTickSummary>((resolve) => (release = () => resolve(IDLE))));
      const { make, logger } = build({}, runOnce);

      const scheduler = make();
      const first = scheduler.tick();
      await scheduler.tick();

      expect(runOnce).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('tick skipped'));
      release();
      await first;

      // The guard is released, not latched: the relay keeps polling after a slow tick.
      runOnce.mockResolvedValue(IDLE);
      await scheduler.tick();
      expect(runOnce).toHaveBeenCalledTimes(2);
    });

    it('swallows a failure — an unhandled rejection in a timer would kill the process', async () => {
      const runOnce = vi.fn().mockRejectedValue(new Error('outbox poll failed'));
      const { make, logger } = build({}, runOnce);

      const scheduler = make();
      await expect(scheduler.tick()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('outbox poll failed'));
      await scheduler.tick();
      expect(runOnce).toHaveBeenCalledTimes(2);
    });

    it('stays quiet on an empty backlog and logs one line when it moved something', async () => {
      const runOnce = vi.fn().mockResolvedValue(IDLE);
      const { make, logger } = build({}, runOnce);
      const scheduler = make();

      await scheduler.tick();
      expect(logger.info).not.toHaveBeenCalled();

      runOnce.mockResolvedValue({ published: 3, failed: 1 });
      await scheduler.tick();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ published: 3, failed: 1 }),
        'outbox relay tick completed',
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the interval so no tick outlives the connection pool', async () => {
      const { make, registry } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      await scheduler.onModuleDestroy();

      expect(registry.deleteInterval).toHaveBeenCalledWith('messaging-outbox-relay');
    });

    it('is safe when no interval was ever registered', async () => {
      const { make, registry } = build({ 'outbox.relayEnabled': false });
      registry.doesExist.mockReturnValue(false);

      await make().onModuleDestroy();

      expect(registry.deleteInterval).not.toHaveBeenCalled();
    });

    it('waits for an open tick to finish rather than cutting its transaction', async () => {
      let release: () => void = () => {};
      const runOnce = vi.fn(() => new Promise<RelayTickSummary>((resolve) => (release = () => resolve(IDLE))));
      const { make } = build({}, runOnce);

      const scheduler = make();
      const tick = scheduler.tick();
      const settled = vi.fn();
      const teardown = scheduler.onModuleDestroy().then(settled);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).not.toHaveBeenCalled();

      release();
      await tick;
      await teardown;
      expect(settled).toHaveBeenCalled();
    });

    it('gives up on a stuck tick instead of blocking shutdown forever', async () => {
      const { make } = build(
        {},
        vi.fn(() => new Promise<RelayTickSummary>(() => {})),
      );

      const scheduler = make();
      void scheduler.tick();
      const teardown = scheduler.onModuleDestroy();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(teardown).resolves.toBeUndefined();
    });
  });
});
