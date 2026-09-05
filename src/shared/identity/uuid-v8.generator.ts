import { hrtime } from 'node:process';
import { EntropyPool } from './entropy-pool';
import { type ClockStallReason, ClockStalledError } from './identity.errors';
import { NODE_COUNT, RANDOM_BITS, SEQUENCE_COUNT, encode } from './uuid-v8.codec';

const RANDOM_BYTES = RANDOM_BITS / 8;
const NS_PER_MS = 1_000_000n;

// A spin normally ends inside one millisecond, so both bounds only matter once the clock has
// stopped. They are not two independent views of that: `systemClock` answers `monotonicMs` and
// `elapsedNs` from the same `hrtime` reading, so a host whose clock is frozen reports no elapsed
// time either and the loop cap is the guard that actually fires. Its real bound is iterations, not
// time, so it is sized to land in the same single-digit milliseconds the deadline describes (an
// iteration costs ~110ns here) instead of a round number the blocking would dwarf. Neither guard
// falls through to reuse a (timestamp, node, sequence) triple.
const SPIN_DEADLINE_NS = 10n * NS_PER_MS;
const SPIN_LOOP_CAP = 40_000;

const NO_STALL = -1;

/** @internal Clock seam. Production always uses `systemClock`; nothing but a test may supply another. */
export interface IdentityClock {
  /** Wall-clock milliseconds. May step in either direction when NTP adjusts it. */
  wallMs(): number;
  /** Non-decreasing milliseconds from an arbitrary origin. */
  monotonicMs(): number;
  /**
   * Real elapsed nanoseconds, bounding how long a spin may block. `systemClock` serves it from the
   * same `hrtime` reading as `monotonicMs`, so on a healthy host the deadline is reachable only by
   * a deschedule landing between the two reads — which is why the spin re-checks the clock before
   * calling that a stall. A test clock can drive the two apart to exercise the guard directly.
   */
  elapsedNs(): bigint;
}

const systemClock: IdentityClock = {
  wallMs: () => Date.now(),
  monotonicMs: () => Number(hrtime.bigint() / NS_PER_MS),
  elapsedNs: () => hrtime.bigint(),
};

/**
 * Mints UUIDv8 ids for one writer: the caller's routing bucket plus this generator's node id, a
 * per-millisecond sequence, and 40 random bits.
 *
 * Fully synchronous by design, and lint-enforced to stay that way: a suspension point between
 * reading the clock and stamping the sequence would let a second caller interleave, and both would
 * emit the same `(timestamp, node, sequence)` triple.
 *
 * Uniqueness across writers rests on distinct node ids, and within one writer on the sequence never
 * being replayed — which a restart inside the millisecond of the process's last mint does replay,
 * since both the sequence and the clock base start fresh. In either case the 40 random bits are all
 * that separate two ids — enough to keep them distinct, not enough to keep them ordered.
 */
export class UuidV8Generator {
  private nodeIdValue: number;
  private lastMs = 0;
  private sequence = 0;
  private offsetMs = 0;
  private stalls = 0;
  private stalledAtMs = NO_STALL;
  private readonly originWallMs: number;
  private readonly originMonotonicMs: number;

  private constructor(
    nodeId: number,
    private readonly clock: IdentityClock,
    private readonly entropy: EntropyPool,
  ) {
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= NODE_COUNT) {
      throw new RangeError(`UUIDv8 nodeId must be an integer in [0, ${NODE_COUNT - 1}]`);
    }
    this.nodeIdValue = nodeId;
    this.originWallMs = clock.wallMs();
    this.originMonotonicMs = clock.monotonicMs();
  }

  static create(options: { nodeId: number }): UuidV8Generator {
    return new UuidV8Generator(options.nodeId, systemClock, new EntropyPool());
  }

  /** @internal The only path that accepts a clock — `create` has no such parameter, so the seam is closed by type rather than by convention. */
  static createWithClock(options: { nodeId: number; clock: IdentityClock }): UuidV8Generator {
    return new UuidV8Generator(options.nodeId, options.clock, new EntropyPool());
  }

  get nodeId(): number {
    return this.nodeIdValue;
  }

  /** Milliseconds of one-way catch-up applied since construction: how far the monotonic base has fallen behind the wall clock. A suspended host resumes with the whole gap here. */
  get clockDriftMs(): number {
    return this.offsetMs;
  }

  get stallCount(): number {
    return this.stalls;
  }

  generate(bucket: number): string {
    let tsMs = this.now();

    // `<=`, not `===`: `now()` cannot regress, but a clock that somehow did would fall into the
    // fresh-millisecond branch, reset the sequence and re-mint ids already emitted. Holding at
    // `lastMs` keeps the triple unique even then.
    if (tsMs <= this.lastMs) {
      tsMs = this.lastMs;
      if (this.sequence === SEQUENCE_COUNT - 1) {
        tsMs = this.spinPast(this.lastMs);
        this.sequence = 0;
      } else {
        this.sequence++;
      }
    } else {
      this.sequence = 0;
    }
    this.lastMs = tsMs;

    return encode({
      tsMs,
      bucket,
      nodeId: this.nodeIdValue,
      sequence: this.sequence,
      random: this.entropy.take(RANDOM_BYTES),
    });
  }

  // Monotonic base plus an offset that only ever grows, so the result cannot go backwards. The
  // obvious `max(wall, monotonic)` does go backwards: an NTP step forward is adopted as the max,
  // and the correcting step back drops the id timestamp by the whole excursion.
  private now(): number {
    const monotonic = this.originWallMs + (this.clock.monotonicMs() - this.originMonotonicMs);
    const behind = this.clock.wallMs() - (monotonic + this.offsetMs);
    if (behind > 0) {
      this.offsetMs += behind;
    }
    return monotonic + this.offsetMs;
  }

  private spinPast(ms: number): number {
    const deadlineNs = this.clock.elapsedNs() + SPIN_DEADLINE_NS;
    // A stopped clock stays stopped, so once a spin has given up at this millisecond the next mint
    // reaches the same answer in one read. Paying the full cap again per request is what keeps a
    // stalled host too busy to answer its own health checks and shed load.
    const cap = this.stalledAtMs === ms ? 1 : SPIN_LOOP_CAP;

    for (let i = 0; i < cap; i++) {
      const tsMs = this.now();
      if (tsMs > ms) {
        this.stalledAtMs = NO_STALL;
        return tsMs;
      }
      // Re-read the clock: a deschedule between the two readings above blows the deadline on a
      // perfectly healthy host, and refusing there would answer 503 to a mint about to succeed.
      if (this.clock.elapsedNs() > deadlineNs && this.now() <= ms) {
        throw this.stall(ms, 'deadline');
      }
    }

    throw this.stall(ms, 'loop_cap');
  }

  private stall(ms: number, reason: ClockStallReason): ClockStalledError {
    this.stalledAtMs = ms;
    this.stalls++;
    return new ClockStalledError(reason);
  }
}
