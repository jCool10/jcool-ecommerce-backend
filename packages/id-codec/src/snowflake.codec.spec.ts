import { randomUUID } from 'node:crypto';
import {
  BUCKET_BITS,
  BUCKET_COUNT,
  EPOCH_MS,
  LAYOUT_VERSION,
  MAX_TIMESTAMP_MS,
  MIN_ROUTABLE_ID,
  MIN_TIMESTAMP_MS,
  NODE_BITS,
  NODE_COUNT,
  SEQUENCE_BITS,
  SEQUENCE_COUNT,
  type SnowflakeFields,
  TIMESTAMP_BITS,
  bucketOf,
  decode,
  encode,
  isRoutableId,
} from './snowflake.codec';

const ROUND_TRIP_SAMPLES = process.env.CI ? 20_000 : 100_000;

// Seeded PRNG so a failing sample is reproducible from the seed alone.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_ELAPSED_MS = 2 ** TIMESTAMP_BITS - 1;

// mulberry32 yields k / 2**32, so one draw scaled past 32 bits lands on an exact multiple and would
// leave the low bits of the 41-bit stamp zero in every sample. Composed from two draws instead.
function randomFields(rand: () => number): SnowflakeFields {
  const elapsed = Math.floor(rand() * 2 ** 21) * 2 ** 20 + Math.floor(rand() * 2 ** 20);
  return {
    tsMs: EPOCH_MS + 1 + (elapsed % MAX_ELAPSED_MS),
    bucket: Math.floor(rand() * BUCKET_COUNT),
    nodeId: Math.floor(rand() * NODE_COUNT),
    sequence: Math.floor(rand() * SEQUENCE_COUNT),
  };
}

const MIN: SnowflakeFields = { tsMs: MIN_TIMESTAMP_MS, bucket: 0, nodeId: 0, sequence: 0 };
const MAX: SnowflakeFields = {
  tsMs: MAX_TIMESTAMP_MS,
  bucket: BUCKET_COUNT - 1,
  nodeId: NODE_COUNT - 1,
  sequence: SEQUENCE_COUNT - 1,
};

describe('snowflake codec', () => {
  it('pins the epoch, which is a permanent wire format', () => {
    expect(EPOCH_MS).toBe(1_767_225_600_000);
    expect(new Date(EPOCH_MS).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(MAX_TIMESTAMP_MS).toISOString()).toBe('2095-09-07T15:47:35.551Z');
  });

  it('round-trips the extremes of every field', () => {
    expect(decode(encode(MIN))).toEqual(MIN);
    expect(decode(encode(MAX))).toEqual(MAX);

    for (const field of ['tsMs', 'bucket', 'nodeId', 'sequence'] as const) {
      const onlyThisFieldMaxed = { ...MIN, [field]: MAX[field] };
      expect(decode(encode(onlyThisFieldMaxed))).toEqual(onlyThisFieldMaxed);

      const onlyThisFieldMinned = { ...MAX, [field]: MIN[field] };
      expect(decode(encode(onlyThisFieldMinned))).toEqual(onlyThisFieldMinned);
    }
  });

  it('round-trips every single bit of every field', () => {
    let cases = 0;

    for (let bit = 0; bit < TIMESTAMP_BITS; bit++) {
      const fields = { ...MIN, tsMs: EPOCH_MS + 2 ** bit };
      expect(decode(encode(fields))).toEqual(fields);
      cases++;
    }
    for (const [field, width] of [
      ['bucket', 12],
      ['nodeId', 5],
      ['sequence', 5],
    ] as const) {
      for (let bit = 0; bit < width; bit++) {
        const fields = { ...MIN, [field]: 2 ** bit };
        expect(decode(encode(fields))).toEqual(fields);
        cases++;
      }
    }

    expect(cases).toBe(41 + 12 + 5 + 5);
  });

  it('round-trips seeded random field combinations', () => {
    const rand = mulberry32(0xc0ffee);

    for (let i = 0; i < ROUND_TRIP_SAMPLES; i++) {
      const fields = randomFields(rand);
      expect(decode(encode(fields))).toEqual(fields);
    }
  }, 60_000);

  // Round-tripping agrees under ANY layout, so it cannot pin where a field physically sits. This
  // freezes the wire format: a shard router reads the bucket positionally, and swapping two
  // same-width fields is invisible to every other test here while re-routing every row.
  it('places each field at its documented bit position (frozen wire format)', () => {
    const id = encode({ tsMs: 1_800_000_000_000, bucket: 2731, nodeId: 19, sequence: 27 });

    expect(id).toBe('137465797020397179');

    const value = BigInt(id);
    expect(Number(value >> 22n)).toBe(1_800_000_000_000 - EPOCH_MS);
    expect(Number((value >> 10n) & 0xfffn)).toBe(2731);
    expect(Number((value >> 5n) & 0x1fn)).toBe(19);
    expect(Number(value & 0x1fn)).toBe(27);
  });

  it('pins LAYOUT_VERSION to the epoch and to every field width and position', () => {
    const lowBit = (fields: Partial<SnowflakeFields>) =>
      (BigInt(encode({ ...MIN, ...fields })) - BigInt(encode(MIN))).toString(2).length - 1;
    const layout = [
      new Date(EPOCH_MS).toISOString(),
      `ts ${TIMESTAMP_BITS}@${lowBit({ tsMs: MIN_TIMESTAMP_MS + 1 })}`,
      `bucket ${BUCKET_BITS}@${lowBit({ bucket: 1 })}`,
      `node ${NODE_BITS}@${lowBit({ nodeId: 1 })}`,
      `seq ${SEQUENCE_BITS}@${lowBit({ sequence: 1 })}`,
    ].join(' | ');

    expect(
      { layout, version: LAYOUT_VERSION },
      'A layout change is a data migration that rewrites every id, plus a LAYOUT_VERSION bump',
    ).toEqual({ layout: '2026-01-01T00:00:00.000Z | ts 41@22 | bucket 12@10 | node 5@5 | seq 5@0', version: 1 });
  });

  it('orders by time: a later millisecond always encodes larger', () => {
    const early = BigInt(encode({ tsMs: 1_800_000_000_000, bucket: 4095, nodeId: 31, sequence: 31 }));
    const late = BigInt(encode({ tsMs: 1_800_000_000_001, bucket: 0, nodeId: 0, sequence: 0 }));

    expect(late).toBeGreaterThan(early);
  });

  it('stays inside the signed 63-bit range for every encodable timestamp', () => {
    expect(BigInt(encode(MAX))).toBeLessThan(1n << 63n);
    expect(BigInt(encode(MIN))).toBeGreaterThanOrEqual(1n << 22n);
  });

  it('rejects out-of-range fields instead of truncating them', () => {
    expect(() => encode({ ...MIN, bucket: BUCKET_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...MIN, nodeId: NODE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...MIN, sequence: SEQUENCE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: MAX_TIMESTAMP_MS + 1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, bucket: -1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, bucket: 1.5 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, bucket: NaN })).toThrow(RangeError);
  });

  // The epoch millisecond itself encodes to a value below MIN_ROUTABLE_ID, which is exactly what makes
  // a small integer impossible to mistake for an id. Refusing it at encode keeps the two ends honest.
  it('refuses a timestamp at or before the epoch', () => {
    expect(() => encode({ ...MIN, tsMs: EPOCH_MS })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: EPOCH_MS - 1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: 0 })).toThrow(RangeError);
  });

  it('decode throws on ids from the UUID layout it replaces', () => {
    for (let i = 0; i < 100; i++) {
      expect(() => bucketOf(randomUUID())).toThrow(TypeError);
    }
    expect(() => bucketOf('0198d9c1-9800-8aab-9fff-ff0000000001')).toThrow(TypeError);
  });

  it('decode throws (never returns NaN) on malformed input', () => {
    const malformed = [
      '',
      ' ',
      '0',
      '01',
      '-1',
      '1.5',
      '1e18',
      '0x10',
      '+1',
      ' 137465797020397179',
      '137465797020397179 ',
      'not-an-id',
      '1_000_000',
      '4194303', // one below the smallest encodable value
      (1n << 63n).toString(), // one past the signed range
      '9999999999999999999', // 19 digits, but past 2^63-1
    ];

    for (const id of malformed) {
      expect(() => decode(id)).toThrow(TypeError);
      expect(isRoutableId(id)).toBe(false);
    }
  });

  it('decode throws on non-string input', () => {
    const notStrings: unknown[] = [null, undefined, 42, Number('137465797020397179'), {}, [], true];

    for (const value of notStrings) {
      expect(() => decode(value as string)).toThrow(TypeError);
      expect(isRoutableId(value)).toBe(false);
    }
  });

  it('does not echo the rejected input in its error', () => {
    for (const id of ['4194303', '9999999999999999999', '0198d9c1-9800-8aab-9fff-ff0000000001']) {
      let message = '';
      try {
        decode(id);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/^Not a routable id/);
      expect(message).not.toContain(id);
    }
  });

  it('accepts the smallest and largest encodable ids', () => {
    expect(MIN_ROUTABLE_ID).toBe(4_194_304n);
    expect(encode(MIN)).toBe(MIN_ROUTABLE_ID.toString());
    expect(isRoutableId('4194304')).toBe(true);
    expect(isRoutableId(((1n << 63n) - 1n).toString())).toBe(true);
  });

  it('reads the bucket back out of an encoded id for every bucket value', () => {
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      expect(bucketOf(encode({ ...MIN, bucket, tsMs: 1_800_000_000_000 }))).toBe(bucket);
    }
  });

  // node-postgres hands int8 back as a string. This is the reason nothing may put an id through
  // Number on the way to or from the database, or into JSON as a number.
  it('loses digits the moment it passes through Number', () => {
    const id = encode(MAX);

    expect(id).toHaveLength(19);
    expect(BigInt(id).toString()).toBe(id);
    expect(Number(id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(String(Number(id))).not.toBe(id);
  });
});
