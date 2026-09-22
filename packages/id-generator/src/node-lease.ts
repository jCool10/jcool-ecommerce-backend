import { type IdentityClock, systemClock } from './identity-clock';
import { LeaseNotHeldError } from './identity.errors';
import type { LeaseStore } from './lease-store.port';
import { SnowflakeGenerator } from './snowflake.generator';

export const LEASE_STATES = [
  'idle',
  'acquiring',
  'held',
  'fenced',
  'draining',
  'lost',
  'exhausted',
  'released',
] as const;

export type LeaseState = (typeof LEASE_STATES)[number];

export interface NodeLeaseOptions {
  store: LeaseStore;
  /** For diagnosis only. A holder is recognised by the generation it was granted. */
  holder: string;
  ttlMs: number;
  quarantineMs: number;
  /** How long before the store would expire the lease this process stops minting on its own. */
  fenceMarginMs: number;
  /** How far an inherited floor may sit ahead of the store's clock. Defaults to `fenceMarginMs`. */
  maxFloorAheadMs?: number;
}

export type AcquireOutcome =
  | { kind: 'held'; nodeId: number }
  | { kind: 'exhausted' }
  | { kind: 'floor_rejected'; nodeId: number; aheadMs: number };

export type RenewOutcome = 'renewed' | 'lost';

interface ClockReading {
  wallMs: number;
  monotonicMs: number;
}

interface Held {
  nodeId: number;
  generation: number;
  generator: SnowflakeGenerator;
  /** Taken before the store call that granted or extended the lease, so the deadline errs early. */
  anchor: ClockReading;
  /** On the store's clock. No id is stamped past it, which is what the next holder's floor relies on. */
  leaseUntilMs: number;
}

type Phase = 'idle' | 'acquiring' | 'held' | 'lost' | 'exhausted' | 'released';

/**
 * Mints only under a node id the store has leased to this process, and stops on its own clock
 * before the store's clock could hand that id to someone else. The fence is checked on every mint,
 * so no timer has to fire for it to hold.
 *
 * One store operation at a time: the caller owns the schedule and must not overlap them.
 */
export class NodeLease {
  private phase: Phase = 'idle';
  private held: Held | null = null;
  private draining = false;
  private inFlight = false;
  // Carried into every later generator, so re-acquiring the same node never mints below itself.
  private retiredLastMs = 0;
  private readonly maxFloorAheadMs: number;

  private constructor(
    private readonly options: NodeLeaseOptions,
    private readonly clock: IdentityClock,
  ) {
    const { holder, ttlMs, quarantineMs, fenceMarginMs } = options;
    this.maxFloorAheadMs = options.maxFloorAheadMs ?? fenceMarginMs;
    if (holder === '') throw new RangeError('Lease holder must not be empty');
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError('Lease ttlMs must be a positive integer');
    if (!Number.isInteger(fenceMarginMs) || fenceMarginMs <= 0 || fenceMarginMs >= ttlMs) {
      throw new RangeError('Lease fenceMarginMs must be a positive integer below ttlMs');
    }
    if (!Number.isInteger(quarantineMs) || quarantineMs < 0) {
      throw new RangeError('Lease quarantineMs must be a non-negative integer');
    }
    if (!Number.isInteger(this.maxFloorAheadMs) || this.maxFloorAheadMs < 0) {
      throw new RangeError('Lease maxFloorAheadMs must be a non-negative integer');
    }
  }

  static create(options: NodeLeaseOptions): NodeLease {
    return new NodeLease(options, systemClock);
  }

  /** @internal Test seam, as on the generator. */
  static createWithClock(options: NodeLeaseOptions & { clock: IdentityClock }): NodeLease {
    return new NodeLease(options, options.clock);
  }

  get state(): LeaseState {
    if (this.phase !== 'held') return this.phase;
    if (this.fenced()) return 'fenced';
    return this.draining ? 'draining' : 'held';
  }

  get nodeId(): number | undefined {
    return this.held?.nodeId;
  }

  get generator(): SnowflakeGenerator | null {
    return this.held?.generator ?? null;
  }

  generate(bucket: number): string {
    if (this.held === null || this.fenced()) throw new LeaseNotHeldError(this.state);
    const id = this.held.generator.generate(bucket);
    // Again after stamping: a freeze between the check and the generator's clock read would
    // otherwise hand out an id from past the lease.
    if (this.fenced()) throw new LeaseNotHeldError(this.state);
    return id;
  }

  acquire(): Promise<AcquireOutcome> {
    if (this.draining) return Promise.reject(new Error('acquire() after draining began'));
    if (this.phase === 'held' || this.phase === 'released') {
      return Promise.reject(new Error(`acquire() while ${this.phase}`));
    }
    return this.exclusive(async () => {
      this.phase = 'acquiring';
      const { store, holder, ttlMs, quarantineMs } = this.options;
      const anchor = this.read();
      const grant = await store.acquire({ holder, ttlMs, quarantineMs });
      if (grant === null) {
        this.phase = 'exhausted';
        return { kind: 'exhausted' };
      }

      const { nodeId, generation, floorMs, prevUntilMs, leaseUntilMs, dbNowMs } = grant;
      if (floorMs !== null && floorMs - dbNowMs > this.maxFloorAheadMs) {
        await store.release({ nodeId, holder, generation, lastMs: null });
        return { kind: 'floor_rejected', nodeId, aheadMs: floorMs - dbNowMs };
      }

      const generator = SnowflakeGenerator.createWithClock({
        nodeId,
        clock: this.clock,
        // `prevUntilMs` covers what the previous holder minted after its last report, whatever its clock said.
        floorMs: Math.max(floorMs ?? 0, prevUntilMs, this.retiredLastMs),
      });
      this.held = { nodeId, generation, generator, anchor, leaseUntilMs };
      this.phase = 'held';
      return { kind: 'held', nodeId };
    });
  }

  /** Throws on a store failure without giving the lease up: it stays usable until the fence. */
  renew(): Promise<RenewOutcome> {
    const held = this.held;
    if (held === null) return Promise.reject(new Error(`renew() while ${this.phase}`));
    return this.exclusive(async () => {
      const { store, holder, ttlMs } = this.options;
      const anchor = this.read();
      const leaseUntilMs = await store.renew({
        nodeId: held.nodeId,
        holder,
        generation: held.generation,
        ttlMs,
        lastMs: held.generator.lastTimestampMs,
      });
      if (leaseUntilMs === null) {
        this.retire('lost');
        return 'lost';
      }
      held.anchor = anchor;
      held.leaseUntilMs = leaseUntilMs;
      return 'renewed';
    });
  }

  /** Keeps minting on the node already held, but never acquires another. */
  drain(): void {
    this.draining = true;
  }

  release(): Promise<void> {
    this.draining = true;
    return this.exclusive(async () => {
      const held = this.held;
      // Minting stops before the store hears of it, so the recorded floor covers every id minted.
      this.retire('released');
      if (held === null) return;
      await this.options.store.release({
        nodeId: held.nodeId,
        holder: this.options.holder,
        generation: held.generation,
        lastMs: held.generator.lastTimestampMs || null,
      });
    });
  }

  private retire(phase: Phase): void {
    if (this.held !== null) {
      this.retiredLastMs = Math.max(this.retiredLastMs, this.held.generator.lastTimestampMs);
    }
    this.held = null;
    this.phase = phase;
  }

  // Both clocks, because each fails alone: the monotonic one stands still through a host suspend,
  // and the wall one can step backwards. A wall clock running ahead of the monotonic one by more
  // than the margin is itself a suspend, which only a successful renew can clear. The last check
  // needs no clock agreement at all: an id stamped past the lease end.
  private fenced(): boolean {
    if (this.held === null) return true;
    const { ttlMs, fenceMarginMs } = this.options;
    const now = this.read();
    const monotonicElapsed = now.monotonicMs - this.held.anchor.monotonicMs;
    const wallElapsed = now.wallMs - this.held.anchor.wallMs;
    return (
      Math.max(monotonicElapsed, wallElapsed) >= ttlMs - fenceMarginMs ||
      wallElapsed - monotonicElapsed > fenceMarginMs ||
      this.held.generator.lastTimestampMs > this.held.leaseUntilMs
    );
  }

  private read(): ClockReading {
    return { wallMs: this.clock.wallMs(), monotonicMs: this.clock.monotonicMs() };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight) throw new Error('NodeLease operations must not overlap');
    this.inFlight = true;
    try {
      return await operation();
    } finally {
      this.inFlight = false;
    }
  }
}
