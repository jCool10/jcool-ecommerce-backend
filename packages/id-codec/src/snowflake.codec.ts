// Signed 63-bit layout, MSB -> LSB:
//   45 ts_ms (since EPOCH_MS) | 8 node | 10 seq
// The sign bit stays 0 so the value fits a Postgres `bigint` and compares as an integer there.
//
// Values pass 2^53 on 2027-02-02, so an id is a decimal STRING everywhere outside Postgres.
// Handing one to JSON.parse as a number silently rounds it.

/** Wire format. Changing it rewrites the meaning of every id already issued. */
export const EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Bumped by any change to the epoch, the field widths below or their order, and pinned in the database:
 * every stored id decodes into different fields under another layout, and ids minted under a wider
 * timestamp shift sort below the ones already stored.
 */
export const LAYOUT_VERSION = 2;

export const TIMESTAMP_BITS = 45;
export const NODE_BITS = 8;
export const SEQUENCE_BITS = 10;

export const NODE_COUNT = 2 ** NODE_BITS;
export const SEQUENCE_COUNT = 2 ** SEQUENCE_BITS;

/** Latest wall clock an id can carry: 3140-12-13T12:41:28.831Z. */
export const MAX_TIMESTAMP_MS = EPOCH_MS + 2 ** TIMESTAMP_BITS - 1;
/** The epoch millisecond itself is not encodable — see `MIN_ROUTABLE_ID`. */
export const MIN_TIMESTAMP_MS = EPOCH_MS + 1;

export interface SnowflakeFields {
  /** Absolute wall clock, the same unit as `node_leases.max_ts_ms` and the generator's `floorMs`. */
  tsMs: number;
  nodeId: number;
  sequence: number;
}

const SEQUENCE_SHIFT = 0n;
const NODE_SHIFT = BigInt(SEQUENCE_BITS);
const TIMESTAMP_SHIFT = BigInt(SEQUENCE_BITS + NODE_BITS);

const NODE_MASK = BigInt(NODE_COUNT - 1);
const SEQUENCE_MASK = BigInt(SEQUENCE_COUNT - 1);

// No leading zero, no sign, no exponent: two spellings of one id would be two primary keys.
const CANONICAL_DECIMAL = /^[1-9][0-9]{0,18}$/;

/**
 * Every value below 2^18 has an all-zero timestamp field, so small integers (row ids, counts, array
 * indexes) are refused. It is not a type check: an epoch-seconds or epoch-ms stamp is large enough
 * to pass and decodes into real-looking fields.
 */
export const MIN_ROUTABLE_ID = 1n << TIMESTAMP_SHIFT;
const MAX_VALUE = (1n << 63n) - 1n;

function toRoutable(value: unknown): bigint | null {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= MIN_ROUTABLE_ID && parsed <= MAX_VALUE ? parsed : null;
}

function assertField(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`Snowflake ${name} must be an integer in [${min}, ${max}]`);
  }
}

export function encode(fields: SnowflakeFields): string {
  const { tsMs, nodeId, sequence } = fields;
  assertField('tsMs', tsMs, MIN_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
  assertField('nodeId', nodeId, 0, NODE_COUNT - 1);
  assertField('sequence', sequence, 0, SEQUENCE_COUNT - 1);

  const value =
    (BigInt(tsMs - EPOCH_MS) << TIMESTAMP_SHIFT) |
    (BigInt(nodeId) << NODE_SHIFT) |
    (BigInt(sequence) << SEQUENCE_SHIFT);

  return value.toString();
}

// Strict on purpose: a lenient parse yields NaN fields, which compare false against everything.
export function decode(id: string): SnowflakeFields {
  const value = toRoutable(id);
  if (value === null) {
    throw new TypeError('Not a routable id: expected a canonical decimal integer in [2^18, 2^63)');
  }

  return {
    tsMs: Number(value >> TIMESTAMP_SHIFT) + EPOCH_MS,
    nodeId: Number((value >> NODE_SHIFT) & NODE_MASK),
    sequence: Number((value >> SEQUENCE_SHIFT) & SEQUENCE_MASK),
  };
}

/** Predicate form for validators, which run per request and must not raise to decide. */
export function isRoutableId(value: unknown): value is string {
  return toRoutable(value) !== null;
}
