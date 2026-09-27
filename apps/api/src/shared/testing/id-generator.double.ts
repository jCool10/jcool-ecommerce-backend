import { SEQUENCE_COUNT, encode } from '@jcool/id-codec';
import type { IdGeneratorPort } from '@shared/identity/id-generator.port';

/** A fixed, routable id in the given bucket, distinct per `n`. */
export function sampleId(n = 0, bucket = 0): string {
  return encode({
    tsMs: Date.UTC(2026, 8, 1) + Math.floor(n / SEQUENCE_COUNT),
    bucket,
    nodeId: 1,
    sequence: n % SEQUENCE_COUNT,
  });
}

/** Mints routable ids in the requested bucket and records every bucket asked for. */
export class RecordingIdGenerator implements IdGeneratorPort {
  readonly buckets: number[] = [];
  private minted = 0;

  mint(bucket: number, count = 1): Promise<string[]> {
    this.buckets.push(bucket);
    return Promise.resolve(Array.from({ length: count }, () => sampleId(this.minted++, bucket)));
  }
}
