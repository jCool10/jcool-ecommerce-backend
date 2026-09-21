import type { IdentityClock } from './identity-clock';
import { ClockStalledError } from './identity.errors';
import { SnowflakeGenerator } from './snowflake.generator';
import { NODE_COUNT, SEQUENCE_COUNT, decode } from '@jcool/id-codec';

const BUCKET = 2731;
// After EPOCH_MS (2026-01-01), which is the earliest encodable instant.
const START_MS = 1_800_000_000_000;

const ORDERING_SAMPLES = process.env.CI ? 20_000 : 100_000;
const UNIQUENESS_SAMPLES = process.env.CI ? 50_000 : 100_000;

interface FakeClock {
  clock: IdentityClock;
  /** Both clocks move together, as on a healthy host. A negative step breaks the monotonic contract on purpose. */
  advance(ms: number): void;
  /** Only the wall clock moves — an NTP step, or a suspended host resuming. */
  stepWallBy(ms: number): void;
  /** Moves both clocks forward on the Nth elapsed-time read, releasing a spin from inside the loop. */
  releaseAfterSpinReads(reads: number, byMs: number): void;
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
    setElapsedStepNs: (stepNs) => {
      elapsedStep = stepNs;
    },
  };
}

/** Fills one generator's whole per-millisecond sequence, leaving the next mint to spin. */
function drainSequence(generator: SnowflakeGenerator): void {
  for (let i = 0; i < SEQUENCE_COUNT; i++) generator.generate(BUCKET);
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

  // The layout carries no random bits any more, so this is the whole of the per-node guarantee.
  it('never repeats an id on one node, whatever the clock does', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 7, clock: fake.clock });
    // Enough elapsed time per read that a spin always finds its next millisecond.
    fake.setElapsedStepNs(0n);
    const seen = new Set<string>();

    for (let i = 0; i < UNIQUENESS_SAMPLES; i++) {
      // Half the per-millisecond sequence per step, so a mint never has to spin against a frozen
      // clock — that is the stall path, and it has its own test.
      if (i % (SEQUENCE_COUNT / 2) === 0) fake.advance(1);
      if (i % 991 === 0) fake.stepWallBy(-5_000);
      if (i % 1_499 === 0) fake.stepWallBy(3_000);
      seen.add(generator.generate(BUCKET));
    }

    expect(seen.size).toBe(UNIQUENESS_SAMPLES);
  }, 60_000);

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

  it('keeps ids strictly increasing while the wall clock walks backwards', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 1, clock: fake.clock });
    let previous = 0n;

    for (let i = 0; i < ORDERING_SAMPLES; i++) {
      if (i % (SEQUENCE_COUNT / 2) === 0) fake.advance(1);
      if (i % 517 === 0) fake.stepWallBy(-1_000);
      const current = BigInt(generator.generate(BUCKET));
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  }, 60_000);

  it('does not drop an NTP step forward when the correction comes back', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 2, clock: fake.clock });

    generator.generate(BUCKET);
    fake.stepWallBy(10_000);
    const afterJump = decode(generator.generate(BUCKET));
    fake.stepWallBy(-10_000);
    const afterCorrection = decode(generator.generate(BUCKET));

    expect(afterJump.tsMs).toBe(START_MS + 10_000);
    expect(afterCorrection.tsMs).toBeGreaterThanOrEqual(afterJump.tsMs);
    expect(generator.clockDriftMs).toBe(10_000);
  });

  it('starts past floorMs when it takes over a node another holder used', () => {
    const fake = fakeClock();
    const floorMs = START_MS + 5_000;
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 11, clock: fake.clock, floorMs });

    const first = decode(generator.generate(BUCKET));

    expect(first.tsMs).toBeGreaterThan(floorMs);
    // The lift is not drift, and must not be reported as such.
    expect(generator.clockDriftMs).toBe(0);
  });

  it('ignores a floorMs already in the past', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 11, clock: fake.clock, floorMs: START_MS - 60_000 });

    expect(decode(generator.generate(BUCKET)).tsMs).toBe(START_MS);
  });

  it('refuses to mint rather than reuse a sequence value when the clock stops', () => {
    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });
    drainSequence(generator);
    fake.setElapsedStepNs(1_000_000n);

    expect(() => generator.generate(BUCKET)).toThrow(ClockStalledError);
    expect(generator.stallCount).toBe(1);
  });

  it('rejects a floorMs outside the encodable range', () => {
    const clock = fakeClock().clock;

    expect(() => SnowflakeGenerator.createWithClock({ nodeId: 0, clock, floorMs: -1 })).toThrow(RangeError);
    expect(() => SnowflakeGenerator.createWithClock({ nodeId: 0, clock, floorMs: 1.5 })).toThrow(RangeError);
  });

  it('refuses to mint on a host whose clock predates the epoch', () => {
    const fake = fakeClock(1_700_000_000_000);
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });

    expect(() => generator.generate(BUCKET)).toThrow(RangeError);
  });
});
