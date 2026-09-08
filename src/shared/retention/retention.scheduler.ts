import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { runInJobContext } from '@shared/observability/correlation/job-context';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { withSpan } from '@shared/observability/tracing/tracer';
import type { RetentionSweep } from './retention-sweep.port';
import { RetentionSweepRegistry } from './retention-sweep.registry';

const LOG_CONTEXT = 'RetentionScheduler';
const INTERVAL_NAME = 'shared-retention-sweep';

/**
 * Starts at `onApplicationBootstrap`, not `onModuleInit`: module init is interleaved, so a scheduler
 * started there can tick before the last context has registered its sweep — and that sweep would
 * never run, silently. The `running` flag, `catch` and timeout are per sweep, not per tick, so one
 * blocked or throwing sweep cannot cost the others theirs.
 */
@Injectable()
export class RetentionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly running = new Set<string>();
  private announced = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly sweepTimeoutMs: number;

  constructor(
    private readonly registry: RetentionSweepRegistry,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    // A mistyped key reads as undefined, and `setInterval(fn, undefined)` fires every event-loop
    // turn — a busy loop issuing DELETEs. Refuse to build rather than boot that.
    this.enabled = config.get<boolean>('retention.enabled') === true;
    this.intervalMs = requireInt(config, 'retention.intervalMs', 1);
    this.batchSize = requireInt(config, 'retention.batchSize', 1);
    this.sweepTimeoutMs = requireInt(config, 'retention.sweepTimeoutMs', 1);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.info({ context: LOG_CONTEXT }, 'retention sweeps disabled');
      return;
    }
    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info(
      {
        context: LOG_CONTEXT,
        intervalMs: this.intervalMs,
        batchSize: this.batchSize,
        sweeps: this.registry.names(),
      },
      'retention sweeps scheduled',
    );
  }

  onModuleDestroy(): void {
    // Cleared explicitly: a timer surviving shutdown would keep firing against a closed pool.
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Public so a test can drive one pass without a timer. */
  async tick(): Promise<void> {
    const sweeps = this.registry.all();

    if (!this.announced) {
      this.announced = true;
      // A sweep that was never registered produces no error and no metric. This roster is the only
      // place "swept nothing" and "was never asked to sweep" are distinguishable.
      this.logger.info(
        { context: LOG_CONTEXT, sweeps: sweeps.map((s) => s.name), count: sweeps.length },
        'retention sweeps running for the first time',
      );
    }

    // Concurrent (different tables), with a correlation context per sweep rather than per tick so a
    // retention incident reads one table at a time. `runSweep` handles its own failures, but the
    // caller is `void this.tick()` on a timer where an unhandled rejection kills the process.
    try {
      await Promise.all(
        sweeps.map((sweep) =>
          runInJobContext(this.cls, `retention:${sweep.name}`, () =>
            withSpan(`retention.sweep.${sweep.name}`, () => this.runSweep(sweep)),
          ),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ context: LOG_CONTEXT }, `retention tick failed outside any single sweep: ${message}`);
    }
  }

  private async runSweep(sweep: RetentionSweep): Promise<void> {
    if (this.running.has(sweep.name)) {
      // Counted, not just logged: a statement that never settles leaves this sweep skipping every
      // tick from here on, and the timeout already recorded its one failure — so without this the
      // sweep goes flat in metrics, indistinguishable from a table with nothing to collect.
      this.metrics.recordRetentionSweepFailure(sweep.name);
      this.logger.warn({ context: LOG_CONTEXT, sweep: sweep.name }, 'previous retention sweep still running — skipped');
      return;
    }
    this.running.add(sweep.name);

    const startedAt = process.hrtime.bigint();
    // Deliberately NOT `sweep.sweep(...).finally(...)`: a sync throw would escape before `.finally`
    // attached, leaking `running` forever. The flag is cleared by the statement finishing, not by
    // the timeout below, which stops waiting on the DELETE without stopping the DELETE.
    const work = Promise.resolve()
      .then(() => sweep.sweep(this.batchSize))
      .finally(() => this.running.delete(sweep.name));
    work.catch(() => undefined);

    try {
      const deleted = await withTimeout(work, this.sweepTimeoutMs, sweep.name);
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.recordRetentionSweep(sweep.name, deleted);
      this.metrics.observeRetentionSweepDuration(sweep.name, seconds);

      if (deleted === 0) return; // Idle sweeps are the steady state; logging them buries the rest.

      if (deleted === this.batchSize) {
        // A full batch means the table had more to give. Once is a backlog being worked off; every
        // tick forever means rows arrive faster than this reclaims them.
        this.logger.warn(
          { context: LOG_CONTEXT, sweep: sweep.name, deleted, batchSize: this.batchSize, seconds },
          'retention sweep filled its batch — more rows are waiting than one tick can reclaim',
        );
        return;
      }
      this.logger.info({ context: LOG_CONTEXT, sweep: sweep.name, deleted, seconds }, 'retention sweep completed');
    } catch (error) {
      this.metrics.recordRetentionSweepFailure(sweep.name);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ context: LOG_CONTEXT, sweep: sweep.name }, `retention sweep failed: ${message}`);
    }
  }
}

/** Bounds the tick, not the query — a DELETE already sent cannot be recalled. */
function withTimeout<T>(work: Promise<T>, ms: number, sweep: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`retention sweep "${sweep}" exceeded ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

function requireInt(config: ConfigService, key: string, min: number): number {
  const value = config.get<number>(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid retention config: ${key} must be an integer >= ${min}`);
  }
  return value;
}
