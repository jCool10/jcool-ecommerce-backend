import { hrtime } from 'node:process';
import { ClockStalledError } from './identity.errors';
import { NODE_COUNT, SEQUENCE_COUNT, decode } from './uuid-v8.codec';
import { type IdentityClock, UuidV8Generator } from './uuid-v8.generator';

const BUCKET = 2731;
const START_MS = 1_756_000_000_000;

// Full N locally, reduced on CI: the assertions are exact either way, only the coverage of the
// (node, sequence) space shrinks.
const EXHAUSTION_NODES = process.env.CI ? 64 : NODE_COUNT;
const ORDERING_SAMPLES = process.env.CI ? 20_000 : 100_000;
const THROUGHPUT_SAMPLES = process.env.CI ? 50_000 : 500_000;
// A hard rate gates the local run only. Across heterogeneous CI runners any number is either
// meaningless or flaky, so CI asserts a structural floor instead — three orders of magnitude below
// the design rate, which an accidentally async or O(n) generate() would still miss.
const RATE_FLOOR_PER_SECOND = process.env.CI ? 50_000 : 500_000;

interface FakeClock {
  clock: IdentityClock;
  /** Both clocks move together, as on a healthy host. A negative step breaks the monotonic contract on purpose. */
  advance(ms: number): void;
  /** Only the wall clock moves — an NTP step, or a suspended host resuming. */
  stepWallBy(ms: number): void;
  /**
   * Move both clocks forward on the Nth elapsed-time read. Only `spinPast` reads elapsed time, so
   * this releases a spin from inside the loop without depending on how many times `now()` happens
   * to read the clock — a coupling that would let a refactor of `now()` silently skip the spin.
   */
  releaseAfterSpinReads(reads: number, byMs: number): void;
  /** Elapsed-time reads served. `spinPast` is their only caller, so a rise proves the spin ran. */
  spinReadCount(): number;
  /** Nanoseconds the elapsed-time reading advances per call; 0 leaves it frozen. */
  setElapsedStepNs(stepNs: bigint): void;
}

function fakeClock(startMs = START_MS): FakeClock {
  let wall = startMs;
  let monotonic = startMs;
  let elapsed = 0n;
  let elapsedStep = 0n;
  let spinReads = 0;
  let releaseAtSpinRead = -1;
  let releaseBy = 0;

  return {
    clock: {
      wallMs: () => wall,
      monotonicMs: () => monotonic,
      elapsedNs: () => {
        spinReads += 1;
        if (spinReads === releaseAtSpinRead) {
          monotonic += releaseBy;
          wall += releaseBy;
        }
        const current = elapsed;
        elapsed += elapsedStep;
        return current;
      },
    },
    advance: (ms) => {
      wall += ms;
      monotonic += ms;
    },
    stepWallBy: (ms) => {
      wall += ms;
    },
    releaseAfterSpinReads: (afterReads, byMs) => {
      releaseAtSpinRead = spinReads + afterReads;
      releaseBy = byMs;
    },
    spinReadCount: () => spinReads,
    setElapsedStepNs: (stepNs) => {
      elapsedStep = stepNs;
    },
  };
}

/** Fills one generator's whole per-millisecond sequence, leaving the next mint to spin. */
function drainSequence(generator: UuidV8Generator): void {
  for (let i = 0; i < SEQUENCE_COUNT; i++) generator.generate(BUCKET);
}

/** Exhausts a sequence against a frozen clock so the next mint must spin, and returns how it gave up. */
function stallOnExhaustedSequence(elapsedStepNs: bigint): { error: ClockStalledError; stallCount: number } {
  const fake = fakeClock();
  const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });
  drainSequence(generator);
  fake.setElapsedStepNs(elapsedStepNs);

  try {
    generator.generate(BUCKET);
  } catch (error) {
    if (error instanceof ClockStalledError) {
      return { error, stallCount: generator.stallCount };
    }
    throw error;
  }
  throw new Error('expected the mint to refuse rather than reuse a sequence value');
}

describe('uuid-v8 generator', () => {
  it('stamps the caller bucket and its own node id', () => {
    const generator = UuidV8Generator.createWithClock({ nodeId: 511, clock: fakeClock().clock });

    const fields = decode(generator.generate(BUCKET));

    expect(fields.bucket).toBe(BUCKET);
    expect(fields.nodeId).toBe(511);
    expect(generator.nodeId).toBe(511);
  });

  it('rejects a node id outside the 10-bit field at construction, not at the first mint', () => {
    expect(() => UuidV8Generator.create({ nodeId: NODE_COUNT })).toThrow(RangeError);
    expect(() => UuidV8Generator.create({ nodeId: -1 })).toThrow(RangeError);
    expect(() => UuidV8Generator.create({ nodeId: 1.5 })).toThrow(RangeError);
  });

  // Exhausts the (node, sequence) space of a single millisecond. Indexed by the fields read back
  // out of each id rather than by the loop variables, so a generator that ignored its inputs and
  // emitted a counter could not pass. This proves the codec is injective and that one process
  // sequences correctly — not that node ids are unique, which the test itself supplies.
  it('mints every (node, sequence) combination exactly once within one millisecond', () => {
    const clock = fakeClock().clock;
    const combinations = EXHAUSTION_NODES * SEQUENCE_COUNT;
    const seen = new Uint8Array(combinations / 8);
    let distinct = 0;
    let fieldsIntact = 0;

    for (let nodeId = 0; nodeId < EXHAUSTION_NODES; nodeId++) {
      const generator = UuidV8Generator.createWithClock({ nodeId, clock });

      for (let i = 0; i < SEQUENCE_COUNT; i++) {
        const fields = decode(generator.generate(BUCKET));
        if (fields.tsMs === START_MS && fields.bucket === BUCKET) fieldsIntact++;

        const index = (fields.nodeId << 12) | fields.sequence;
        const mask = 1 << (index % 8);
        if ((seen[index >>> 3] & mask) === 0) {
          seen[index >>> 3] |= mask;
          distinct++;
        }
      }
    }

    expect(distinct).toBe(combinations);
    expect(fieldsIntact).toBe(combinations);
  }, 120_000);

  it('emits ids that sort lexicographically into the order they were minted', () => {
    const generator = UuidV8Generator.create({ nodeId: 7 });
    const ids: string[] = [];
    for (let i = 0; i < ORDERING_SAMPLES; i++) ids.push(generator.generate(BUCKET));

    const sorted = [...ids].sort();
    let outOfOrder = 0;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== sorted[i]) outOfOrder++;
    }

    // Within one process and one node. Across writers the ordering guarantee is the node id's, and
    // this generator does not own that.
    expect(outOfOrder).toBe(0);
  }, 60_000);
});

describe('uuid-v8 generator clock', () => {
  it('never goes backwards across an NTP step forward and back', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });
    const timestamps: number[] = [];

    for (let i = 0; i < 50; i++) {
      timestamps.push(decode(generator.generate(BUCKET)).tsMs);
      fake.advance(1);
    }

    fake.stepWallBy(3_600_000);
    const afterStepForward = decode(generator.generate(BUCKET)).tsMs;
    timestamps.push(afterStepForward);

    // The correcting step back is the half that breaks `max(wall, monotonic)`: it would adopt the
    // stepped-forward value and then drop an hour on the way back.
    fake.stepWallBy(-3_600_000);
    for (let i = 0; i < 50; i++) {
      fake.advance(1);
      timestamps.push(decode(generator.generate(BUCKET)).tsMs);
    }

    let backwards = 0;
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) backwards++;
    }

    expect(backwards).toBe(0);
    expect(afterStepForward).toBeGreaterThanOrEqual(START_MS + 3_600_000);
    expect(timestamps[timestamps.length - 1]).toBeGreaterThanOrEqual(afterStepForward);
  });

  it('catches up in one step after a suspended host resumes', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });

    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS);
    expect(generator.clockDriftMs).toBe(0);

    // Suspend: the monotonic clock froze for the whole outage, the wall clock resumes 40s ahead.
    fake.stepWallBy(40_000);

    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS + 40_000);
    expect(generator.clockDriftMs).toBe(40_000);

    let backwards = 0;
    let previous = START_MS + 40_000;
    for (let i = 0; i < 100; i++) {
      const tsMs = decode(generator.generate(BUCKET)).tsMs;
      if (tsMs < previous) backwards++;
      previous = tsMs;
    }
    expect(backwards).toBe(0);
  });

  // No healthy host can do this, and the seam is the only way to stage it. It is worth staging:
  // the failure would not be a visible fault but a silent one — a reset sequence re-minting ids
  // that were already handed out.
  it('holds the last millisecond rather than re-minting when a clock regresses', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });

    const first = decode(generator.generate(BUCKET));
    fake.advance(10);
    const second = decode(generator.generate(BUCKET));
    fake.advance(-10);
    const third = decode(generator.generate(BUCKET));

    expect(second.tsMs).toBe(first.tsMs + 10);
    expect(third.tsMs).toBe(second.tsMs);
    expect(third.sequence).toBe(second.sequence + 1);
  });

  it('spins into the next millisecond when the sequence is exhausted', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);

    // Read 1 arms the deadline, 2 is a spin iteration finding the clock unchanged, 3 releases it.
    // Without the spin the mint would reuse START_MS at sequence 0.
    fake.releaseAfterSpinReads(3, 1);
    const fields = decode(generator.generate(BUCKET));

    expect(fields.tsMs).toBe(START_MS + 1);
    expect(fields.sequence).toBe(0);
    expect(generator.stallCount).toBe(0);
    // The three assertions above are also satisfied by a generator that never spins and simply
    // returns `lastMs + 1`. Only `spinPast` reads elapsed time, so this is what separates them.
    expect(fake.spinReadCount()).toBeGreaterThan(0);
  });

  // The production clock answers both readings from one `hrtime`, so the only way real time can
  // outrun the deadline while the clock is healthy is a deschedule — a GC pause or a stolen CPU
  // slice — landing between the two reads. Refusing there would 503 a registration that was one
  // read away from succeeding.
  it('mints rather than refusing when the deadline is blown but the clock has moved on', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);

    // 15ms of real time passes per elapsed read, so the deadline is already blown on the first
    // iteration — and the same read is where the clock resumes.
    fake.setElapsedStepNs(15n * 1_000_000n);
    fake.releaseAfterSpinReads(2, 1);

    const fields = decode(generator.generate(BUCKET));

    expect(fields.tsMs).toBe(START_MS + 1);
    expect(fields.sequence).toBe(0);
    expect(generator.stallCount).toBe(0);
  });

  it('gives up on the loop cap when nothing observable advances at all', () => {
    // A suspended host reports neither a moving clock nor elapsed time, so the deadline can never
    // fire and only the iteration cap ends the spin.
    const stalled = stallOnExhaustedSequence(0n);

    expect(stalled.error.reason).toBe('loop_cap');
    expect(stalled.stallCount).toBe(1);
  }, 30_000);

  it('fails fast on the mints after a stall instead of spinning the cap again', () => {
    const fake = fakeClock();
    const generator = UuidV8Generator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);

    expect(() => generator.generate(BUCKET)).toThrow(ClockStalledError);
    const firstSpin = fake.spinReadCount();
    expect(() => generator.generate(BUCKET)).toThrow(ClockStalledError);
    const secondSpin = fake.spinReadCount() - firstSpin;

    expect(generator.stallCount).toBe(2);
    // Spinning the full cap on every request is what keeps a stalled host too busy to answer its
    // own health checks, so the repeat has to cost a clock read rather than the whole loop.
    expect(secondSpin * 100).toBeLessThan(firstSpin);

    // The shortcut is not a latch that wedges the generator: a clock that comes back mints again.
    fake.advance(1);
    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS + 1);
  }, 30_000);

  it('gives up on the deadline when real time runs on but the clock does not', () => {
    const stalled = stallOnExhaustedSequence(1_000_000n);

    expect(stalled.error.reason).toBe('deadline');
    expect(stalled.stallCount).toBe(1);
  });
});

describe('uuid-v8 generator uniqueness under a duplicated node id', () => {
  // The uniqueness invariant is "no two writers share a node id". This is what breaking it costs:
  // the ordered prefix collides completely and only the random tail still separates the ids.
  it('collides on every (timestamp, node, sequence) yet still emits distinct ids', () => {
    const first = UuidV8Generator.createWithClock({ nodeId: 42, clock: fakeClock().clock });
    const second = UuidV8Generator.createWithClock({ nodeId: 42, clock: fakeClock().clock });

    let prefixCollisions = 0;
    let distinctIds = 0;

    for (let i = 0; i < 1000; i++) {
      const a = first.generate(BUCKET);
      const b = second.generate(BUCKET);
      const left = decode(a);
      const right = decode(b);

      if (left.tsMs === right.tsMs && left.nodeId === right.nodeId && left.sequence === right.sequence) {
        prefixCollisions++;
      }
      if (a !== b) distinctIds++;
    }

    expect(prefixCollisions).toBe(1000);
    expect(distinctIds).toBe(1000);
  });
});

describe('uuid-v8 generator throughput', () => {
  it('stays on the synchronous path', () => {
    const generator = UuidV8Generator.create({ nodeId: 0 });

    const startNs = hrtime.bigint();
    for (let i = 0; i < THROUGHPUT_SAMPLES; i++) generator.generate(BUCKET);
    const elapsedNs = Number(hrtime.bigint() - startNs);

    const perSecond = Math.round((THROUGHPUT_SAMPLES * 1e9) / elapsedNs);
    console.log(`uuid-v8 generator: ${perSecond.toLocaleString('en-US')} id/s`);

    expect(perSecond).toBeGreaterThanOrEqual(RATE_FLOOR_PER_SECOND);
  }, 60_000);
});
