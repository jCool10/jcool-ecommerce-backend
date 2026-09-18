import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { durationToMs } from '@shared/kernel';
import { runInJobContext } from '@shared/observability/correlation/job-context';
import { toError } from '@shared/kernel/to-error';
import { withSpan } from '@shared/observability/tracing/tracer';
import { SweepExpiredReservationsUseCase, type SweepInput } from '../application/use-cases';

const LOG_CONTEXT = 'ReservationTtlScheduler';
const INTERVAL_NAME = 'order-reservation-ttl-sweep';

/**
 * The interval is registered dynamically rather than via `@Cron`, whose decorator is evaluated long
 * before ConfigService exists; disabled means no timer at all, not a timer that returns early.
 *
 * Safe on replicas without a leader election, but not because of the read's `SKIP LOCKED` — that
 * lock dies with its statement. Finalize's row lock and terminal guard are what make two ticks
 * landing on the same order cost a duplicate attempt rather than a duplicate effect.
 */
@Injectable()
export class ReservationTtlScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly sweep: SweepInput;
  private readonly config: ConfigService;

  constructor(
    private readonly sweepExpired: SweepExpiredReservationsUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    // A mistyped key reads as undefined, and `setInterval(fn, undefined)` fires every event-loop
    // turn — a busy loop opening transactions. Refuse to build rather than boot that.
    this.enabled = config.get<boolean>('reservationSweep.enabled') === true;
    this.intervalMs = requireInt(config, 'reservationSweep.intervalMs', 1);
    this.sweep = {
      graceSec: requireInt(config, 'reservationSweep.graceSec', 0),
      batchSize: requireInt(config, 'reservationSweep.batchSize', 1),
    };
    this.config = config;
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('reservation expiry sweep disabled');
      return;
    }
    this.assertBehindReconcile();
    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info({ intervalMs: this.intervalMs }, 'reservation expiry sweep scheduled');
  }

  onModuleDestroy(): void {
    // Cleared explicitly: a timer surviving shutdown would keep firing against a closed pool.
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous reservation expiry sweep still running — tick skipped');
      return;
    }
    this.running = true;
    try {
      // A timer has no request and no inbound trace: the span puts a trace id on this tick's lines,
      // the job context a correlation id for readers with no tracing backend. One of each per tick,
      // not per order — the batch is the unit of work, and each order carries its own id already.
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('reservation.sweep', async () => {
          const summary = await this.sweepExpired.execute(this.sweep);
          // A full batch that expired nothing means the oldest holds cannot be cleared, and the read
          // is ordered oldest-first — so they will fill every tick from here on and newer holds never
          // get looked at. Distinct from the catch below: the sweep worked, its queue is jammed.
          if (summary.scanned === this.sweep.batchSize && summary.expired === 0) {
            this.logger.error(
              { ...summary, stuck: true },
              'reservation expiry sweep filled a batch without expiring anything — stock stays held',
            );
          } else if (summary.scanned > 0) {
            // Idle sweeps are the common case; logging them buries the ticks that did something.
            this.logger.info({ ...summary }, 'reservation expiry sweep completed');
          }
        }),
      );
    } catch (error) {
      // Per-order failures are already isolated, so this is the sweep itself breaking. Swallow it:
      // an unhandled rejection in a timer kills the process.
      this.logger.error({ err: toError(error) }, 'reservation expiry sweep failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * The safeguard this sweep depends on is that the gateway-driven reconcile reaches an order first,
   * because only that one can close the checkout session. Nothing in this module's own config
   * expresses that — the deadline comes from Inventory's hold TTL and reconcile's order TTL — so the
   * two keys are read here, where the timer that would violate the ordering is about to start.
   */
  private assertBehindReconcile(): void {
    const holdTtlSec = durationToMs(this.config.getOrThrow<string>('inventory.reservationTtl')) / 1000;
    const orderTtlSec = requireInt(this.config, 'reconcile.orderTtlSec', 0);
    const claimsAtSec = holdTtlSec + this.sweep.graceSec;

    if (claimsAtSec < orderTtlSec) {
      throw new Error(
        `Reservation sweep would expire orders before reconcile can close their checkout sessions: ` +
          `holds lapse at ${holdTtlSec}s + ${this.sweep.graceSec}s grace, reconcile expires at ${orderTtlSec}s`,
      );
    }
  }
}

function requireInt(config: ConfigService, key: string, min: number): number {
  const value = config.get<number>(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid reservation sweep config: ${key} must be an integer >= ${min}`);
  }
  return value;
}
