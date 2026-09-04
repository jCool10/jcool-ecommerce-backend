import { randomUUID } from 'node:crypto';
import {
  BUCKET_COUNT,
  MAX_RANDOM,
  MAX_TIMESTAMP_MS,
  NODE_COUNT,
  SEQUENCE_COUNT,
  UUID_VARIANT,
  UUID_VERSION,
  bucketOf,
  decode,
  encode,
  type UuidV8Fields,
} from './uuid-v8.codec';

// Statistical/exhaustive volumes: full N locally and in the nightly job, reduced on CI so the
// deterministic correctness stays gated without the multi-minute cost on shared runners.
const STAMP_SAMPLES = process.env.CI ? 100_000 : 1_000_000;
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

function randomFields(rand: () => number): UuidV8Fields {
  return {
    tsMs: Math.floor(rand() * (MAX_TIMESTAMP_MS + 1)),
    bucket: Math.floor(rand() * BUCKET_COUNT),
    nodeId: Math.floor(rand() * NODE_COUNT),
    sequence: Math.floor(rand() * SEQUENCE_COUNT),
    random: Math.floor(rand() * (MAX_RANDOM + 1)),
  };
}

const FIELD_WIDTHS: Array<[keyof UuidV8Fields, number]> = [
  ['tsMs', 48],
  ['bucket', 12],
  ['nodeId', 10],
  ['sequence', 12],
  ['random', 40],
];

const ZERO: UuidV8Fields = { tsMs: 0, bucket: 0, nodeId: 0, sequence: 0, random: 0 };

describe('uuid-v8 codec', () => {
  it('stamps version 8 and variant 0b10 on every id', () => {
    const rand = mulberry32(0x5eed);
    let conformant = 0;

    for (let i = 0; i < STAMP_SAMPLES; i++) {
      const id = encode(randomFields(rand));
      const versionNibble = parseInt(id[14], 16);
      const variantBits = parseInt(id[19], 16) >>> 2;
      if (versionNibble === UUID_VERSION && variantBits === UUID_VARIANT) conformant++;
    }

    // Counted, not asserted inside the loop: a `continue`-style skip could not pass this.
    expect(conformant).toBe(STAMP_SAMPLES);
  }, 60_000);

  it('round-trips the extremes of every field', () => {
    const max: UuidV8Fields = {
      tsMs: MAX_TIMESTAMP_MS,
      bucket: BUCKET_COUNT - 1,
      nodeId: NODE_COUNT - 1,
      sequence: SEQUENCE_COUNT - 1,
      random: MAX_RANDOM,
    };

    expect(decode(encode(ZERO))).toEqual(ZERO);
    expect(decode(encode(max))).toEqual(max);

    for (const [field] of FIELD_WIDTHS) {
      const onlyThisFieldMaxed = { ...ZERO, [field]: max[field] };
      expect(decode(encode(onlyThisFieldMaxed))).toEqual(onlyThisFieldMaxed);

      const onlyThisFieldZero = { ...max, [field]: 0 };
      expect(decode(encode(onlyThisFieldZero))).toEqual(onlyThisFieldZero);
    }
  });

  it('round-trips every single bit of every field', () => {
    let cases = 0;

    for (const [field, width] of FIELD_WIDTHS) {
      for (let bit = 0; bit < width; bit++) {
        const fields = { ...ZERO, [field]: 2 ** bit };
        expect(decode(encode(fields))).toEqual(fields);
        cases++;
      }
    }

    expect(cases).toBe(48 + 12 + 10 + 12 + 40);
  });

  it('round-trips seeded random field combinations', () => {
    const rand = mulberry32(0xc0ffee);

    for (let i = 0; i < ROUND_TRIP_SAMPLES; i++) {
      const fields = randomFields(rand);
      expect(decode(encode(fields))).toEqual(fields);
    }
  }, 60_000);

  it('encodes to a canonical 8-4-4-4-12 lowercase hex string', () => {
    const id = encode({ tsMs: 1_756_000_000_000, bucket: 2731, nodeId: 511, sequence: 4095, random: 1 });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects out-of-range fields instead of truncating them', () => {
    expect(() => encode({ ...ZERO, bucket: BUCKET_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, nodeId: NODE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, sequence: SEQUENCE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, tsMs: MAX_TIMESTAMP_MS + 1 })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, random: MAX_RANDOM + 1 })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, bucket: -1 })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, bucket: 1.5 })).toThrow(RangeError);
    expect(() => encode({ ...ZERO, bucket: NaN })).toThrow(RangeError);
  });

  it('bucketOf throws on real v4 ids', () => {
    for (let i = 0; i < 100; i++) {
      expect(() => bucketOf(randomUUID())).toThrow(/Not a UUIDv8/);
    }
  });

  it('bucketOf throws on a v7 id', () => {
    expect(() => bucketOf('01991b3c-1f40-7c2a-9b8e-3f5a1c2d4e6f')).toThrow(/Not a UUIDv8/);
  });

  it('bucketOf throws (never returns NaN) on malformed input', () => {
    const malformed = [
      '',
      'not-a-uuid',
      'zzzzzzzz-zzzz-8zzz-8zzz-zzzzzzzzzzzz',
      '0199-1b3c1f40-8c2a-9b8e-3f5a1c2d4e6f',
      '01991b3c1f408c2a9b8e3f5a1c2d4e6f',
      '01991b3c-1f40-8c2a-9b8e-3f5a1c2d4e6',
      '01991b3c-1f40-8c2a-9b8e-3f5a1c2d4e6ff',
    ];

    for (const id of malformed) {
      expect(() => bucketOf(id)).toThrow(TypeError);
    }
  });

  it('rejects a v8 id carrying a non-RFC variant', () => {
    const valid = encode({ ...ZERO, bucket: 1 });
    // Byte 8 is the variant byte; 0b00xxxxxx is the legacy NCS variant, not RFC 9562's 0b10.
    const wrongVariant = `${valid.slice(0, 19)}0${valid.slice(20)}`;
    expect(() => bucketOf(wrongVariant)).toThrow(/variant/);
  });

  it('reads the bucket back out of an encoded id for every bucket value', () => {
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      expect(bucketOf(encode({ ...ZERO, bucket, tsMs: 1_756_000_000_000 }))).toBe(bucket);
    }
  });
});
