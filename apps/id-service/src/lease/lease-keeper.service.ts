import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Counter } from 'prom-client';
import { type AcquireOutcome, NodeLease, type RenewOutcome } from '@jcool/id-generator';
import { toError } from '@jcool/kernel';
import { bindIdentityClockMetrics, unbindIdentityClockMetrics } from '@jcool/platform/metrics';
import type { LeaseConfig } from '../config/configuration';
import {
  bindLeaseMetrics,
  ID_LEASE_FLOOR_REJECTIONS_TOTAL,
  ID_LEASE_LOST_TOTAL,
  ID_LEASE_RENEW_FAILURES_TOTAL,
  unbindLeaseMetrics,
} from './lease.metrics';

const LOG_CONTEXT = 'LeaseKeeper';
const MAX_RETRY_MS = 1_000;

/**
 * Drives the lease: acquire, renew, re-acquire after a loss. Each store operation is scheduled only
 * once the previous one settled, which is the no-overlap contract NodeLease asks of its caller.
 */
@Injectable()
export class LeaseKeeper implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly renewEveryMs: number;
  private readonly retryMs: number;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private step: Promise<void> = Promise.resolve();
  private draining = false;
  private stopped = false;
  private renewFailureStreak = 0;
  private exhaustionReported = false;
  private floorRejectionReported = false;

  constructor(
    private readonly lease: NodeLease,
    config: ConfigService,
    private readonly logger: PinoLogger,
    @InjectMetric(ID_LEASE_RENEW_FAILURES_TOTAL) private readonly renewFailures: Counter,
    @InjectMetric(ID_LEASE_LOST_TOTAL) private readonly losses: Counter,
    @InjectMetric(ID_LEASE_FLOOR_REJECTIONS_TOTAL) private readonly floorRejections: Counter,
  ) {
    const { ttlMs, fenceMarginMs, renewEveryMs } = config.getOrThrow<LeaseConfig>('lease');
    if (renewEveryMs >= ttlMs - fenceMarginMs) {
      throw new RangeError('ID_LEASE_RENEW_EVERY_MS must stay below ID_LEASE_TTL_MS - ID_LEASE_FENCE_MARGIN_MS');
    }
    this.renewEveryMs = renewEveryMs;
    this.retryMs = Math.min(renewEveryMs, MAX_RETRY_MS);
    this.graceMs = config.get<number>('app.shutdownGracePeriodMs') ?? 0;
    logger.setContext(LOG_CONTEXT);
  }

  // Only the first attempt is awaited: a replica that finds no node still boots and reports not ready.
  async onApplicationBootstrap(): Promise<void> {
    bindLeaseMetrics(this.lease);
    await this.run(() => this.acquire());
  }

  // Renewal carries on while draining, so the node stays ours until release.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    this.lease.drain();
    this.logger.info({ signal, graceMs: this.graceMs, nodeId: this.lease.nodeId }, 'draining; still minting');
    if (this.graceMs > 0) await new Promise((resolve) => setTimeout(resolve, this.graceMs));
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.step;

    const { nodeId, generator } = this.lease;
    try {
      await this.lease.release();
      if (nodeId !== undefined) this.logger.info({ nodeId }, 'node lease released');
    } catch (err) {
      this.logger.warn({ nodeId, err: toError(err) }, 'node lease release failed; it will expire instead');
    } finally {
      if (generator !== null) unbindIdentityClockMetrics(generator);
      unbindLeaseMetrics(this.lease);
    }
  }

  private run(operation: () => Promise<void>): Promise<void> {
    this.step = operation();
    return this.step;
  }

  private schedule(delayMs: number, operation: () => Promise<void>): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(operation);
    }, delayMs);
    this.timer.unref();
  }

  private async acquire(): Promise<void> {
    if (this.draining) return;
    let outcome: AcquireOutcome;
    try {
      outcome = await this.lease.acquire();
    } catch (err) {
      this.logger.warn({ err: toError(err) }, 'node lease acquire failed');
      this.schedule(this.retryMs, () => this.acquire());
      return;
    }

    switch (outcome.kind) {
      case 'held': {
        this.exhaustionReported = false;
        this.floorRejectionReported = false;
        const { generator } = this.lease;
        if (generator !== null) bindIdentityClockMetrics(generator);
        this.logger.info({ nodeId: outcome.nodeId }, 'node lease acquired');
        this.schedule(this.renewEveryMs, () => this.renew());
        return;
      }
      case 'floor_rejected':
        this.floorRejections.inc();
        if (!this.floorRejectionReported) {
          this.logger.error(
            { nodeId: outcome.nodeId, aheadMs: outcome.aheadMs },
            "node handed back: its previous holder's last timestamp is ahead of the database clock",
          );
        }
        this.floorRejectionReported = true;
        this.schedule(this.retryMs, () => this.acquire());
        return;
      case 'exhausted':
        if (!this.exhaustionReported) this.logger.error('node lease pool exhausted; not ready until a node frees up');
        this.exhaustionReported = true;
        this.schedule(this.retryMs, () => this.acquire());
        return;
    }
  }

  private async renew(): Promise<void> {
    const { nodeId, generator } = this.lease;
    let outcome: RenewOutcome;
    try {
      outcome = await this.lease.renew();
    } catch (err) {
      this.renewFailures.inc();
      if (this.renewFailureStreak++ === 0) {
        this.logger.warn({ nodeId, err: toError(err) }, 'node lease renew failed; minting until the fence');
      }
      this.schedule(this.retryMs, () => this.renew());
      return;
    }

    if (this.renewFailureStreak > 0) {
      this.logger.info({ nodeId, failures: this.renewFailureStreak }, 'node lease renew recovered');
      this.renewFailureStreak = 0;
    }
    if (outcome === 'renewed') {
      this.schedule(this.renewEveryMs, () => this.renew());
      return;
    }

    this.losses.inc();
    if (generator !== null) unbindIdentityClockMetrics(generator);
    this.logger.error({ nodeId }, 'node lease lost; minting stopped');
    await this.acquire();
  }
}
