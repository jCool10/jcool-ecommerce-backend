import { Buffer } from 'node:buffer';
import { randomFillSync } from 'node:crypto';
import { EntropyPool } from './entropy-pool';
import { MAX_RANDOM, RANDOM_BITS } from './uuid-v8.codec';

// Real randomness by default; the refill test swaps in a deterministic fill, because a CSPRNG
// cannot be seeded and refill behaviour is otherwise unobservable from the outside.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomFillSync: vi.fn(actual.randomFillSync) };
});

const fillMock = vi.mocked(randomFillSync);
const RANDOM_BYTES = RANDOM_BITS / 8;
const DRAWS = process.env.CI ? 100_000 : 1_000_000;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  fillMock.mockReset();
  fillMock.mockImplementation(actual.randomFillSync);
});

describe('entropy pool', () => {
  it('draws integers inside the 40-bit random field', () => {
    const pool = new EntropyPool();
    let outOfRange = 0;

    for (let i = 0; i < DRAWS; i++) {
      const value = pool.take(RANDOM_BYTES);
      if (!Number.isInteger(value) || value < 0 || value > MAX_RANDOM) outOfRange++;
    }

    expect(outOfRange).toBe(0);
  }, 60_000);

  it('never hands out the same value twice in a row', () => {
    const pool = new EntropyPool();
    let repeats = 0;
    let previous = pool.take(RANDOM_BYTES);

    for (let i = 1; i < DRAWS; i++) {
      const value = pool.take(RANDOM_BYTES);
      if (value === previous) repeats++;
      previous = value;
    }

    expect(repeats).toBe(0);
  }, 60_000);

  // A draw straddling a refill would mix stale bytes into a fresh value. The pool size is not a
  // multiple of the draw, so two fit and the third must start at offset 0 of a fresh fill; the fill
  // pattern varies with position, so reading at the wrong offset fails too.
  it('refills on a whole-draw boundary, never splicing one draw across two fills', () => {
    let fills = 0;
    fillMock.mockImplementation((buffer: Buffer) => {
      fills += 1;
      for (let i = 0; i < buffer.length; i++) buffer[i] = fills * 0x10 + i;
      return buffer;
    });

    const pool = new EntropyPool(12);

    expect(pool.take(5)).toBe(0x1011121314);
    expect(pool.take(5)).toBe(0x1516171819);
    expect(pool.take(5)).toBe(0x2021222324); // a splice would read 0x1a1b202122
    expect(fills).toBe(2);
  });

  // Otherwise the failure surfaces as an out-of-bounds read at the first mint rather than here.
  it('rejects a pool too small to serve a draw', () => {
    expect(() => new EntropyPool(4)).toThrow(RangeError);
    expect(() => new EntropyPool(0)).toThrow(RangeError);
  });

  it('refills only when the pool runs out, not on every draw', () => {
    const pool = new EntropyPool(5120);
    for (let i = 0; i < 1024; i++) pool.take(RANDOM_BYTES);

    expect(fillMock).toHaveBeenCalledTimes(1);

    pool.take(RANDOM_BYTES);
    expect(fillMock).toHaveBeenCalledTimes(2);
  });
});
