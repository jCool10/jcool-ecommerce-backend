import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { OutboxRelay } from './outbox-relay';

const LOG_CONTEXT = 'OutboxRelayScheduler';
const INTERVAL_NAME = 'messaging-outbox-relay';
// Long enough for a tick that is merely slow, short enough that SIGTERM never waits on a stuck one.
const DRAIN_TIMEOUT_MS = 5_000;

/** Owns the schedule and nothing else, so the relay stays something a test can drive tick by tick. */
@Injectable()
export class OutboxRelayScheduler implements OnModuleInit, OnModuleDestroy {
  private inFlight: Promise<void> | null = null;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly relay: OutboxRelay,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly logger: PinoLogger,
  ) {
    // A mistyped key reads as undefined, and `setInterval(fn, undefined)` fires every event-loop
    // turn — a busy loop opening a transaction against the outbox. Refuse to build rather than boot that.
    this.enabled = config.get<boolean>('outbox.relayEnabled') === true;
    this.intervalMs = requireInt(config, 'outbox.pollMs', 1);
    this.batchSize = requireInt(config, 'outbox.batchSize', 1);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info({ context: LOG_CONTEXT }, 'outbox relay disabled');
      return;
    }
    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info(
      { context: LOG_CONTEXT, intervalMs: this.intervalMs, batchSize: this.batchSize },
      'outbox relay scheduled',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
    // Let an open tick commit instead of having the pool close underneath it. Bounded, because
    // shutdown blocking forever is worse than one aborted transaction.
    await Promise.race([this.inFlight ?? Promise.resolve(), sleep(DRAIN_TIMEOUT_MS)]);
  }

  async tick(): Promise<void> {
    if (this.inFlight) {
      // Overlapping ticks poll the same backlog twice: harmless, never useful.
      this.logger.warn({ context: LOG_CONTEXT }, 'previous outbox relay tick still running — tick skipped');
      return;
    }
    this.inFlight = this.run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(): Promise<void> {
    try {
      const summary = await this.relay.runOnce(this.batchSize);
      // An idle backlog is the steady state; logging it would bury the ticks that moved something.
      if (summary.published > 0 || summary.failed > 0) {
        this.logger.info({ context: LOG_CONTEXT, ...summary }, 'outbox relay tick completed');
      }
    } catch (error) {
      // The poll itself broke (the per-row failures are handled inside). Swallow it: an unhandled
      // rejection in a timer kills the process.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ context: LOG_CONTEXT }, `outbox relay tick failed: ${message}`);
    }
  }
}

function requireInt(config: ConfigService, key: string, min: number): number {
  const value = config.get<number>(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid outbox relay config: ${key} must be an integer >= ${min}`);
  }
  return value;
}

// A pending drain must not hold the process open once the tick it was racing has finished.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
