import { Buffer } from 'node:buffer';

// RFC 9562 §5.8 custom layout, MSB -> LSB:
//   48 ts_ms | 4 ver=8 | 12 bucket | 2 var=0b10 | 10 node | 12 seq | 40 random
// A future shard split reads the bucket straight out of the id, so the layout is a wire format.

export const UUID_VERSION = 8;
export const UUID_VARIANT = 0b10;

export const TIMESTAMP_BITS = 48;
export const BUCKET_BITS = 12;
export const NODE_BITS = 10;
export const SEQUENCE_BITS = 12;
export const RANDOM_BITS = 40;

export const BUCKET_COUNT = 2 ** BUCKET_BITS;
export const NODE_COUNT = 2 ** NODE_BITS;
export const SEQUENCE_COUNT = 2 ** SEQUENCE_BITS;
export const MAX_TIMESTAMP_MS = 2 ** TIMESTAMP_BITS - 1;
export const MAX_RANDOM = 2 ** RANDOM_BITS - 1;

export interface UuidV8Fields {
  tsMs: number;
  bucket: number;
  nodeId: number;
  sequence: number;
  random: number;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertField(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`UUIDv8 ${name} must be an integer in [0, ${max}]`);
  }
}

// Strict on purpose: a lenient parse yields NaN fields, and a NaN bucket is a silent misroute.
function toBytes(id: string): Buffer {
  if (typeof id !== 'string' || !CANONICAL_UUID.test(id)) {
    throw new TypeError('Not a canonical UUID string');
  }
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

export function encode(fields: UuidV8Fields): string {
  const { tsMs, bucket, nodeId, sequence, random } = fields;
  assertField('tsMs', tsMs, MAX_TIMESTAMP_MS);
  assertField('bucket', bucket, BUCKET_COUNT - 1);
  assertField('nodeId', nodeId, NODE_COUNT - 1);
  assertField('sequence', sequence, SEQUENCE_COUNT - 1);
  assertField('random', random, MAX_RANDOM);

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(tsMs, 0, 6);
  bytes[6] = (UUID_VERSION << 4) | ((bucket >>> 8) & 0x0f);
  bytes[7] = bucket & 0xff;
  bytes[8] = (UUID_VARIANT << 6) | ((nodeId >>> 4) & 0x3f);
  bytes[9] = ((nodeId & 0x0f) << 4) | ((sequence >>> 8) & 0x0f);
  bytes[10] = sequence & 0xff;
  bytes.writeUIntBE(random, 11, 5);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decode(id: string): UuidV8Fields {
  const bytes = toBytes(id);

  const version = bytes[6] >>> 4;
  if (version !== UUID_VERSION) {
    throw new TypeError(`Not a UUIDv8: version nibble is ${version}`);
  }
  const variant = bytes[8] >>> 6;
  if (variant !== UUID_VARIANT) {
    throw new TypeError(`Not an RFC 9562 variant: variant bits are 0b${variant.toString(2)}`);
  }

  return {
    tsMs: bytes.readUIntBE(0, 6),
    bucket: ((bytes[6] & 0x0f) << 8) | bytes[7],
    nodeId: ((bytes[8] & 0x3f) << 4) | (bytes[9] >>> 4),
    sequence: ((bytes[9] & 0x0f) << 8) | bytes[10],
    random: bytes.readUIntBE(11, 5),
  };
}

/** Routing bucket carried by a v8 id. Throws on a v4/v7/malformed id rather than returning a fallback, which would route the row to a shard that does not hold it. */
export function bucketOf(id: string): number {
  return decode(id).bucket;
}
