import { hrtime } from 'node:process';
import { NoNodeAvailableError } from './lease.errors';
import type { NodeIdLeasePort, NodeLease } from './node-id-lease.port';

const NS_PER_MS = 1_000_000n;
const RENEWALS_PER_TTL = 3;
/** Renewal intervals a fenced process stays up before it exits. */
const GRACE_INTERVALS = 3;

/** What the holder needs from a generator, without importing one. */
export interface MintSource {
  /** Highest millisecond minted at; reported on every renewal and on release. */
  readonly lastMs: number;
  fence(): void;
}

export interface LeaseHolderOptions {
  service: string;
  holder: string;
  ttlSeconds: number;
  skewMs: number;
  /** Called once when the lease is provably gone, after the source is fenced. */
  onLost: () => void;
  /** Called after the grace window. Production exits the process. */
  onGiveUp: () => void;
  monotonicMs?: () => number;
}

/**
 * Framework-free — a port and a clock, no Nest — so the standalone seed scripts hold a lease without
 * booting an app, the same way `IdentityService` is constructible outside Nest.
 */
export class LeaseHolder {
  private lease: NodeLease | null = null;
  private source: MintSource | null = null;
  private lost = false;
  private deadlineMonotonicMs = 0;
  private renewedAtMonotonicMs = 0;
  private renewTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private giveUpTimer: NodeJS.Timeout | null = null;
  private renewalFailures = 0;
  private lostCount = 0;

  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly marginMs: number;
  private readonly monotonicMs: () => number;

  constructor(
    private readonly leases: NodeIdLeasePort,
    private readonly options: LeaseHolderOptions,
  ) {
    this.ttlMs = options.ttlSeconds * 1000;
    this.renewIntervalMs = Math.max(1, Math.floor(this.ttlMs / RENEWALS_PER_TTL));
    // The deadline must expire before the row becomes reclaimable, not after. Reclaim opens at
    // renewed_at + ttl, and the database stamps renewed_at somewhere between the request leaving and
    // the response arriving — so anchor at send and subtract a margin at least as large as the skew.
    this.marginMs = Math.min(this.ttlMs, Math.max(options.skewMs, this.renewIntervalMs));
    this.monotonicMs = options.monotonicMs ?? (() => Number(hrtime.bigint() / NS_PER_MS));
  }

  /**
   * The generator is built *from* the node id this holder acquires, so it cannot be a constructor
   * argument. A source attached after the lease was already lost is fenced on arrival — otherwise a
   * steal inside the boot window would leave a generator minting under someone else's node.
   */
  attach(source: MintSource): void {
    this.source = source;
    if (this.lost) source.fence();
  }

  get node(): number | null {
    return this.lease?.node ?? null;
  }

  get isValid(): boolean {
    return this.lease !== null && !this.lost;
  }

  /** Seconds since the last successful renewal — what shows a renewal loop starving toward the TTL. */
  get ageSeconds(): number {
    if (!this.lease) return 0;
    return Math.max(0, (this.monotonicMs() - this.renewedAtMonotonicMs) / 1000);
  }

  get renewalFailureCount(): number {
    return this.renewalFailures;
  }

  get lostTotal(): number {
    return this.lostCount;
  }

  private get lastMs(): number {
    return this.source?.lastMs ?? 0;
  }

  /** Throws rather than degrading: a process with no node id has no safe id to mint under. */
  async start(): Promise<number> {
    const lease = await this.leases.acquire(this.options.service, this.options.holder);
    if (!lease) {
      throw new NoNodeAvailableError(this.options.service);
    }
    this.lease = lease;
    this.markRenewed(this.monotonicMs());
    this.scheduleRenew();
    return lease.node;
  }

  async stop(): Promise<void> {
    this.clearTimers();
    const lease = this.lease;
    this.lease = null;
    if (lease && !this.lost) {
      await this.leases.release(lease, this.lastMs);
    }
  }

  private scheduleRenew(): void {
    this.renewTimer = setTimeout(() => void this.renewOnce(), this.renewIntervalMs);
    this.renewTimer.unref();
  }

  private async renewOnce(): Promise<void> {
    const lease = this.lease;
    if (!lease || this.lost) return;

    const sentAtMs = this.monotonicMs();
    try {
      const held = await this.leases.renew(lease, this.lastMs);
      if (!held) {
        // The only signal that fences immediately: the statement succeeded and the row no longer
        // carries this lease_id. Someone else holds the node.
        this.markLost();
        return;
      }
      this.markRenewed(sentAtMs);
    } catch {
      // A transport or connection error is not a steal. Retry inside the TTL and let the
      // send-anchored deadline decide; fencing here would 503 the fleet on a Postgres blip.
      this.renewalFailures++;
    }
    this.scheduleRenew();
  }

  // The deadline runs on its own timer, independent of any in-flight renewal: a renewal call that
  // hangs past the deadline must still fence, which a check inside the renewal path cannot do.
  private markRenewed(sentAtMs: number): void {
    this.renewedAtMonotonicMs = sentAtMs;
    this.deadlineMonotonicMs = sentAtMs + this.ttlMs - this.marginMs;
    this.clearDeadline();
    this.deadlineTimer = setTimeout(
      () => this.onDeadline(),
      Math.max(0, this.deadlineMonotonicMs - this.monotonicMs()),
    );
    this.deadlineTimer.unref();
  }

  private onDeadline(): void {
    if (this.lost || !this.lease) return;
    if (this.monotonicMs() >= this.deadlineMonotonicMs) {
      this.markLost();
    }
  }

  // Fence, then leave. The node id is constructor-set on the generator, so there is no adopt-a-new-id
  // path to take here — and staying alive fenced is worse than restarting: plain compose DNS and
  // Railway both keep routing to a container whose readiness has gone red, and a fenced user replica
  // 503s every login and registration for as long as it is up. The grace window exists so in-flight
  // requests drain, not so the lease can come back.
  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.lostCount++;
    this.clearTimers();
    this.source?.fence();
    this.options.onLost();
    this.giveUpTimer = setTimeout(() => this.options.onGiveUp(), this.renewIntervalMs * GRACE_INTERVALS);
    this.giveUpTimer.unref();
  }

  // `stop()` reaches the give-up timer too: once a shutdown is under way the drain this window
  // exists for is already happening, and forcing an exit through it would cut that shutdown short.
  private clearTimers(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.giveUpTimer = null;
    this.clearDeadline();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
