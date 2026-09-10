import { hrtime } from 'node:process';
import { EntropyPool } from './entropy-pool';
import { type ClockStallReason, ClockStalledError } from './identity.errors';
import { NODE_COUNT, RANDOM_BITS, SEQUENCE_COUNT, encode } from './uuid-v8.codec';

const RANDOM_BYTES = RANDOM_BITS / 8;
const NS_PER_MS = 1_000_000n;

// Both bounds only matter once the clock has stopped. `systemClock` serves `monotonicMs` and
// `elapsedNs` from one `hrtime` reading, so a frozen clock reports no elapsed time either and the
// loop cap is the guard that fires; it is sized (~110ns/iteration) to blocking the same single-digit
// milliseconds the deadline describes. Neither falls through to reusing a (ts, node, seq) triple.
const SPIN_DEADLINE_NS = 10n * NS_PER_MS;
const SPIN_LOOP_CAP = 40_000;

const NO_STALL = -1;

/** @internal Clock seam. Production always uses `systemClock`; nothing but a test may supply another. */
export interface IdentityClock {
  /** Wall-clock milliseconds. May step in either direction when NTP adjusts it. */
  wallMs(): number;
  /** Non-decreasing milliseconds from an arbitrary origin. */
  monotonicMs(): number;
  /** Real elapsed nanoseconds, bounding how long a spin may block. */
  elapsedNs(): bigint;
}

const systemClock: IdentityClock = {
  wallMs: () => Date.now(),
  monotonicMs: () => Number(hrtime.bigint() / NS_PER_MS),
  elapsedNs: () => hrtime.bigint(),
};

/**
 * Synchronous by design and lint-enforced to stay that way — an await between reading the clock and
 * stamping the sequence lets two callers emit the same `(timestamp, node, sequence)` triple.
 *
 * Uniqueness rests on distinct node ids across writers, and on the sequence never being replayed
 * within one. A restart inside the millisecond of the last mint does replay it (sequence and clock
 * base both start fresh); the 40 random bits keep those ids distinct but not ordered.
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

  /** @internal The only path that accepts a clock, so the seam is closed by type rather than by convention. */
  static createWithClock(options: { nodeId: number; clock: IdentityClock }): UuidV8Generator {
    return new UuidV8Generator(options.nodeId, options.clock, new EntropyPool());
  }

  get nodeId(): number {
    return this.nodeIdValue;
  }

  /** Milliseconds of one-way catch-up applied since construction. A suspended host resumes with the whole gap here. */
  get clockDriftMs(): number {
    return this.offsetMs;
  }

  get stallCount(): number {
    return this.stalls;
  }

  generate(bucket: number): string {
    let tsMs = this.now();

    // `<=`, not `===`: a regressing clock would otherwise take the fresh-millisecond branch, reset
    // the sequence and re-mint ids already emitted.
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

  // Monotonic base plus an offset that only grows, so the result cannot go backwards. The obvious
  // `max(wall, monotonic)` does: it adopts an NTP step forward, then drops the whole excursion when
  // the correcting step comes back.
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
    // Once a spin has given up at this millisecond, the next mint reaches the same answer in one
    // read. Paying the full cap per request would keep a stalled host too busy to fail its own
    // health checks and shed load.
    const cap = this.stalledAtMs === ms ? 1 : SPIN_LOOP_CAP;

    for (let i = 0; i < cap; i++) {
      const tsMs = this.now();
      if (tsMs > ms) {
        this.stalledAtMs = NO_STALL;
        return tsMs;
      }
      // Re-read the clock: a deschedule between the two readings blows the deadline on a healthy
      // host, and refusing there would 503 a mint that was about to succeed.
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
