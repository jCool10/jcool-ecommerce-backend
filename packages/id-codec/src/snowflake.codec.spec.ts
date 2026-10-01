import {
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
  decode,
  encode,
  isRoutableId,
} from './snowflake.codec';

const ROUND_TRIP_SAMPLES = 20_000;

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
// leave the low bits of the 45-bit stamp zero in every sample. Composed from two draws instead.
function randomFields(rand: () => number): SnowflakeFields {
  const elapsed = Math.floor(rand() * 2 ** 25) * 2 ** 20 + Math.floor(rand() * 2 ** 20);
  return {
    tsMs: EPOCH_MS + 1 + (elapsed % MAX_ELAPSED_MS),
    nodeId: Math.floor(rand() * NODE_COUNT),
    sequence: Math.floor(rand() * SEQUENCE_COUNT),
  };
}

const MIN: SnowflakeFields = { tsMs: MIN_TIMESTAMP_MS, nodeId: 0, sequence: 0 };
const MAX: SnowflakeFields = { tsMs: MAX_TIMESTAMP_MS, nodeId: NODE_COUNT - 1, sequence: SEQUENCE_COUNT - 1 };

describe('snowflake codec', () => {
  it('round-trips the extremes and every single bit of every field', () => {
    expect(decode(encode(MIN))).toEqual(MIN);
    expect(decode(encode(MAX))).toEqual(MAX);

    for (const field of ['tsMs', 'nodeId', 'sequence'] as const) {
      const onlyThisFieldMaxed = { ...MIN, [field]: MAX[field] };
      expect(decode(encode(onlyThisFieldMaxed))).toEqual(onlyThisFieldMaxed);

      const onlyThisFieldMinned = { ...MAX, [field]: MIN[field] };
      expect(decode(encode(onlyThisFieldMinned))).toEqual(onlyThisFieldMinned);
    }

    const singleBits: SnowflakeFields[] = [];
    for (let bit = 0; bit < TIMESTAMP_BITS; bit++) singleBits.push({ ...MIN, tsMs: EPOCH_MS + 2 ** bit });
    for (const [field, width] of [
      ['nodeId', NODE_BITS],
      ['sequence', SEQUENCE_BITS],
    ] as const) {
      for (let bit = 0; bit < width; bit++) singleBits.push({ ...MIN, [field]: 2 ** bit });
    }

    expect(singleBits).toHaveLength(45 + 8 + 10);
    expect(singleBits.map((fields) => decode(encode(fields)))).toEqual(singleBits);
  });

  it('round-trips seeded random field combinations', () => {
    const rand = mulberry32(0xc0ffee);

    for (let i = 0; i < ROUND_TRIP_SAMPLES; i++) {
      const fields = randomFields(rand);
      expect(decode(encode(fields))).toEqual(fields);
    }
  });

  // Round-tripping agrees under ANY layout, so it cannot pin where a field physically sits. This
  // freezes the wire format: every stored id is read positionally, and moving a field is invisible
  // to every other test here while rewriting the meaning of every id already issued.
  it('places each field at its documented bit position (frozen wire format)', () => {
    const id = encode({ tsMs: 1_800_000_000_000, nodeId: 173, sequence: 731 });

    expect(id).toBe('8591612313777883');

    const value = BigInt(id);
    expect(Number(value >> 18n)).toBe(1_800_000_000_000 - EPOCH_MS);
    expect(Number((value >> 10n) & 0xffn)).toBe(173);
    expect(Number(value & 0x3ffn)).toBe(731);
  });

  it('pins LAYOUT_VERSION to the epoch and to every field width and position', () => {
    const lowBit = (fields: Partial<SnowflakeFields>) =>
      (BigInt(encode({ ...MIN, ...fields })) - BigInt(encode(MIN))).toString(2).length - 1;
    const layout = [
      new Date(EPOCH_MS).toISOString(),
      `ts ${TIMESTAMP_BITS}@${lowBit({ tsMs: MIN_TIMESTAMP_MS + 1 })}`,
      `node ${NODE_BITS}@${lowBit({ nodeId: 1 })}`,
      `seq ${SEQUENCE_BITS}@${lowBit({ sequence: 1 })}`,
    ].join(' | ');

    expect(
      { layout, version: LAYOUT_VERSION },
      'A layout change is a data migration that rewrites every id, plus a LAYOUT_VERSION bump',
    ).toEqual({ layout: '2026-01-01T00:00:00.000Z | ts 45@18 | node 8@10 | seq 10@0', version: 2 });
  });

  it('orders by time: a later millisecond always encodes larger', () => {
    const early = BigInt(encode({ tsMs: 1_800_000_000_000, nodeId: NODE_COUNT - 1, sequence: SEQUENCE_COUNT - 1 }));
    const late = BigInt(encode({ tsMs: 1_800_000_000_001, nodeId: 0, sequence: 0 }));

    expect(late).toBeGreaterThan(early);
  });

  it('spans 2^18 to 2^63 - 1 and accepts both ends', () => {
    expect(MIN_ROUTABLE_ID).toBe(1n << 18n);
    expect(encode(MIN)).toBe(MIN_ROUTABLE_ID.toString());
    expect(encode(MAX)).toBe(((1n << 63n) - 1n).toString());
    expect(isRoutableId(encode(MIN))).toBe(true);
    expect(isRoutableId(encode(MAX))).toBe(true);
  });

  it('rejects out-of-range fields instead of truncating them', () => {
    expect(() => encode({ ...MIN, nodeId: NODE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...MIN, sequence: SEQUENCE_COUNT })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: MAX_TIMESTAMP_MS + 1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, nodeId: -1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, nodeId: 1.5 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, sequence: NaN })).toThrow(RangeError);
  });

  // The epoch millisecond itself encodes to a value below MIN_ROUTABLE_ID, which is exactly what makes
  // a small integer impossible to mistake for an id. Refusing it at encode keeps the two ends honest.
  it('refuses a timestamp at or before the epoch', () => {
    expect(() => encode({ ...MIN, tsMs: EPOCH_MS })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: EPOCH_MS - 1 })).toThrow(RangeError);
    expect(() => encode({ ...MIN, tsMs: 0 })).toThrow(RangeError);
  });

  // A lenient parse yields NaN fields, which then compare false against everything they are checked by.
  it('refuses anything but a canonical routable decimal string', () => {
    const notIds: unknown[] = [
      '',
      ' ',
      '0',
      '01',
      '-1',
      '1.5',
      '1e18',
      '0x10',
      '+1',
      ' 8591612313777883',
      '8591612313777883 ',
      'not-an-id',
      '1_000_000',
      '262143',
      (1n << 63n).toString(),
      '9999999999999999999',
      '0198d9c1-9800-8aab-9fff-ff0000000001',
      '550e8400-e29b-41d4-a716-446655440000',
      null,
      undefined,
      42,
      Number('8591612313777883'),
      {},
      [],
      true,
    ];

    for (const value of notIds) {
      expect(() => decode(value as string), String(value)).toThrow(TypeError);
      expect(isRoutableId(value), String(value)).toBe(false);
    }
  });

  it('does not echo the rejected input in its error', () => {
    for (const id of ['262143', '9999999999999999999', '0198d9c1-9800-8aab-9fff-ff0000000001']) {
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
});
