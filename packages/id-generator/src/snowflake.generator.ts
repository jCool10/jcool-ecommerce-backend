import { type IdentityClock, systemClock } from './identity-clock';
import { type ClockStallReason, ClockStalledError } from './identity.errors';
import { MAX_TIMESTAMP_MS, NODE_COUNT, SEQUENCE_COUNT, encode } from '@jcool/id-codec';

export type { IdentityClock } from './identity-clock';

const NS_PER_MS = 1_000_000n;

// Both bounds only matter once the clock has stopped. `systemClock` serves `monotonicMs` and
// `elapsedNs` from one `hrtime` reading, so a frozen clock reports no elapsed time either and the
// loop cap is the guard that fires; it is sized (~110ns/iteration) to blocking the same single-digit
// milliseconds the deadline describes. Neither falls through to reusing a (ts, node, seq) triple.
const SPIN_DEADLINE_NS = 10n * NS_PER_MS;
const SPIN_LOOP_CAP = 40_000;

const NO_STALL = -1;

/**
 * Synchronous by design and lint-enforced to stay that way — an await between reading the clock and
 * stamping the sequence lets two callers emit the same `(timestamp, node, sequence)` triple.
 *
 * This layout carries no random bits, so uniqueness rests entirely on the lease: a node id belongs
 * to one holder at a time, and `NodeLease` floors each new holder past the previous holder's whole
 * lease window, not merely past what it last reported minting. A generator built outside that
 * discipline — the two reserved node ids — must never run twice at once.
 */
export class SnowflakeGenerator {
  readonly nodeId: number;
  private lastMs = 0;
  private sequence = 0;
  private offsetMs = 0;
  private stalls = 0;
  private stalledAtMs = NO_STALL;
  private readonly originWallMs: number;
  private readonly originMonotonicMs: number;
  // Apart from offsetMs: the floor is not drift, and clockDriftMs must keep reporting only the latter.
  private readonly liftMs: number;

  private constructor(
    nodeId: number,
    private readonly clock: IdentityClock,
    floorMs: number | undefined,
  ) {
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= NODE_COUNT) {
      throw new RangeError(`Snowflake nodeId must be an integer in [0, ${NODE_COUNT - 1}]`);
    }
    if (floorMs !== undefined && (!Number.isInteger(floorMs) || floorMs < 0 || floorMs >= MAX_TIMESTAMP_MS)) {
      throw new RangeError(`Snowflake floorMs must be an integer in [0, ${MAX_TIMESTAMP_MS - 1}]`);
    }
    this.nodeId = nodeId;
    this.originWallMs = clock.wallMs();
    this.originMonotonicMs = clock.monotonicMs();
    this.liftMs = floorMs === undefined ? 0 : Math.max(0, floorMs + 1 - this.originWallMs);
  }

  /** `floorMs`: the last timestamp a previous holder of this node id may have minted at. */
  static create(options: { nodeId: number; floorMs?: number }): SnowflakeGenerator {
    return new SnowflakeGenerator(options.nodeId, systemClock, options.floorMs);
  }

  /** @internal The only path that accepts a clock, so the seam is closed by type rather than by convention. */
  static createWithClock(options: { nodeId: number; clock: IdentityClock; floorMs?: number }): SnowflakeGenerator {
    return new SnowflakeGenerator(options.nodeId, options.clock, options.floorMs);
  }

  /** Milliseconds of one-way catch-up applied since construction. A suspended host resumes with the whole gap here. */
  get clockDriftMs(): number {
    return this.offsetMs;
  }

  get stallCount(): number {
    return this.stalls;
  }

  /** Timestamp of the last id minted, 0 before the first. */
  get lastTimestampMs(): number {
    return this.lastMs;
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

    return encode({ tsMs, bucket, nodeId: this.nodeId, sequence: this.sequence });
  }

  // Monotonic base plus an offset that only grows, so the result cannot go backwards. The obvious
  // `max(wall, monotonic)` does: it adopts an NTP step forward, then drops the whole excursion when
  // the correcting step comes back.
  private now(): number {
    const monotonic = this.originWallMs + this.liftMs + (this.clock.monotonicMs() - this.originMonotonicMs);
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
