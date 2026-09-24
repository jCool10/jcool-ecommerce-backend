import type { IdentityClock } from './identity-clock';
import { ClockStalledError } from './identity.errors';
import { SnowflakeGenerator } from './snowflake.generator';
import { MAX_TIMESTAMP_MS, NODE_COUNT, SEQUENCE_COUNT, decode } from '@jcool/id-codec';

const BUCKET = 2731;
const START_MS = 1_800_000_000_000;
const FLOOR_MS = START_MS + 5_000;

const ORDERING_SAMPLES = 50_000;

interface FakeClock {
  clock: IdentityClock;
  /** Both clocks move together, as on a healthy host. A negative step breaks the monotonic contract on purpose. */
  advance(ms: number): void;
  /** Only the wall clock moves: an NTP step, or a suspended host resuming. */
  stepWallBy(ms: number): void;
  /** Moves both clocks forward on the Nth elapsed-time read, releasing a spin from inside the loop. */
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
function drainSequence(generator: SnowflakeGenerator): void {
  for (let i = 0; i < SEQUENCE_COUNT; i++) generator.generate(BUCKET);
}

/** Exhausts a sequence against a frozen clock so the next mint must spin, and returns how it gave up. */
function stallOnExhaustedSequence(elapsedStepNs: bigint): { error: ClockStalledError; stallCount: number } {
  const fake = fakeClock();
  const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });
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

describe('snowflake generator', () => {
  it('stamps the caller bucket and its own node id', () => {
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 19, clock: fakeClock().clock });

    const fields = decode(generator.generate(BUCKET));

    expect(fields.bucket).toBe(BUCKET);
    expect(fields.nodeId).toBe(19);
    expect(generator.nodeId).toBe(19);
  });

  it('rejects a node id outside the 5-bit field at construction, not at the first mint', () => {
    const clock = fakeClock().clock;

    expect(() => SnowflakeGenerator.createWithClock({ nodeId: NODE_COUNT, clock })).toThrow(RangeError);
    expect(() => SnowflakeGenerator.createWithClock({ nodeId: -1, clock })).toThrow(RangeError);
    expect(() => SnowflakeGenerator.createWithClock({ nodeId: 1.5, clock })).toThrow(RangeError);
  });

  // The layout carries no random bits, so strictly increasing ids are the whole per-node guarantee.
  it('keeps ids strictly increasing while the wall clock steps both ways', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 7, clock: fake.clock });
    let previous = 0n;
    let outOfOrder = 0;
    let jumpsAhead = 0;

    for (let i = 0; i < ORDERING_SAMPLES; i++) {
      // Half the per-millisecond sequence per step, so a mint never spins against a frozen clock.
      if (i % (SEQUENCE_COUNT / 2) === 0) fake.advance(1);
      if (i % 991 === 0) fake.stepWallBy(-5_000);
      if (i % 1_499 === 0) fake.stepWallBy(8_000);
      const driftBefore = generator.clockDriftMs;
      const current = BigInt(generator.generate(BUCKET));
      if (current <= previous) outOfOrder++;
      if (generator.clockDriftMs > driftBefore) jumpsAhead++;
      previous = current;
    }

    expect(outOfOrder).toBe(0);
    // More than the first mint's: the wall clock also overtook ids already minted.
    expect(jumpsAhead).toBeGreaterThan(1);
  });

  it('runs the sequence to 31 within a millisecond, then moves to the next', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 3, clock: fake.clock });

    const withinOneMs = Array.from({ length: SEQUENCE_COUNT }, () => decode(generator.generate(BUCKET)));

    expect(withinOneMs.map((f) => f.sequence)).toEqual([...Array(SEQUENCE_COUNT).keys()]);
    expect(new Set(withinOneMs.map((f) => f.tsMs)).size).toBe(1);
    expect(SEQUENCE_COUNT).toBe(32);

    fake.releaseAfterSpinReads(1, 1);
    const next = decode(generator.generate(BUCKET));

    expect(next.sequence).toBe(0);
    expect(next.tsMs).toBe(withinOneMs[0].tsMs + 1);
  });

  it('does not drop an NTP step forward when the correction comes back', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 2, clock: fake.clock });

    generator.generate(BUCKET);
    fake.stepWallBy(10_000);
    const afterJump = decode(generator.generate(BUCKET));
    fake.stepWallBy(-10_000);
    fake.advance(1);
    const afterCorrection = decode(generator.generate(BUCKET));

    expect(afterJump.tsMs).toBe(START_MS + 10_000);
    expect(afterCorrection).toMatchObject({ tsMs: afterJump.tsMs + 1, sequence: 0 });
    expect(generator.clockDriftMs).toBe(10_000);
  });

  it('holds the last millisecond rather than re-minting when a clock regresses', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });

    const first = decode(generator.generate(BUCKET));
    fake.advance(10);
    const second = decode(generator.generate(BUCKET));
    fake.advance(-10);
    const third = decode(generator.generate(BUCKET));

    expect(second.tsMs).toBe(first.tsMs + 10);
    expect(third.tsMs).toBe(second.tsMs);
    expect(third.sequence).toBe(second.sequence + 1);
  });

  it('starts past floorMs when it takes over a node another holder used', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 11, clock: fake.clock, floorMs: FLOOR_MS });

    const first = decode(generator.generate(BUCKET));

    expect(first.tsMs).toBeGreaterThan(FLOOR_MS);
    // The lift is not drift, and must not be reported as such.
    expect(generator.clockDriftMs).toBe(0);
  });

  it('keeps counting the sequence while the clock stays below the floor', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 7, clock: fake.clock, floorMs: FLOOR_MS });

    const first = decode(generator.generate(BUCKET));
    fake.stepWallBy(1_000);
    const second = decode(generator.generate(BUCKET));

    expect(second.tsMs).toBe(first.tsMs);
    expect(second.sequence).toBe(first.sequence + 1);
  });

  it('moves on from the lifted start with the monotonic clock', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 7, clock: fake.clock, floorMs: FLOOR_MS });

    generator.generate(BUCKET);
    fake.advance(3);

    expect(decode(generator.generate(BUCKET)).tsMs).toBe(FLOOR_MS + 4);
  });

  it('ignores a floorMs already in the past', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 11, clock: fake.clock, floorMs: START_MS - 60_000 });

    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS);
  });

  it('rejects a floor the timestamp field cannot exceed', () => {
    for (const floorMs of [-1, 1.5, MAX_TIMESTAMP_MS]) {
      expect(() => SnowflakeGenerator.create({ nodeId: 0, floorMs })).toThrow(RangeError);
    }

    const lastUsable = SnowflakeGenerator.createWithClock({
      nodeId: 0,
      clock: fakeClock().clock,
      floorMs: MAX_TIMESTAMP_MS - 1,
    });
    expect(decode(lastUsable.generate(BUCKET)).tsMs).toBe(MAX_TIMESTAMP_MS);
  });

  it('refuses to mint when real time runs on but the clock does not', () => {
    const stalled = stallOnExhaustedSequence(1_000_000n);

    expect(stalled.error.reason).toBe('deadline');
    expect(stalled.stallCount).toBe(1);
  });

  it('gives up on the loop cap when nothing observable advances at all', () => {
    const stalled = stallOnExhaustedSequence(0n);

    expect(stalled.error.reason).toBe('loop_cap');
    expect(stalled.stallCount).toBe(1);
  });

  it('mints rather than refusing when the deadline is blown but the clock has moved on', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);

    // 15ms per elapsed read: the deadline is blown on the same read where the clock resumes.
    fake.setElapsedStepNs(15n * 1_000_000n);
    fake.releaseAfterSpinReads(2, 1);

    const fields = decode(generator.generate(BUCKET));

    expect(fields.tsMs).toBe(START_MS + 1);
    expect(fields.sequence).toBe(0);
    expect(generator.stallCount).toBe(0);
  });

  it('fails fast on the mints after a stall instead of spinning the cap again', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);

    expect(() => generator.generate(BUCKET)).toThrow(ClockStalledError);
    const firstSpin = fake.spinReadCount();
    expect(() => generator.generate(BUCKET)).toThrow(ClockStalledError);
    const secondSpin = fake.spinReadCount() - firstSpin;

    expect(generator.stallCount).toBe(2);
    expect(secondSpin * 100).toBeLessThan(firstSpin);

    fake.advance(1);
    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS + 1);
  });

  it('refuses to mint on a host whose clock predates the epoch', () => {
    const fake = fakeClock(1_700_000_000_000);
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });

    expect(() => generator.generate(BUCKET)).toThrow(RangeError);
  });
});
