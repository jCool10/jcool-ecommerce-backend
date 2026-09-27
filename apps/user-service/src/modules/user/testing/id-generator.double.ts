import { SEQUENCE_COUNT, encode } from '@jcool/id-codec';
import type { IdGeneratorPort } from '../application/ports';

/** Mints routable ids in the requested bucket and records every bucket asked for. */
export class RecordingIdGenerator implements IdGeneratorPort {
  readonly buckets: number[] = [];
  private minted = 0;

  mint(bucket: number, count = 1): Promise<string[]> {
    this.buckets.push(bucket);
    return Promise.resolve(Array.from({ length: count }, () => this.next(bucket)));
  }

  private next(bucket: number): string {
    const n = this.minted++;
    return encode({
      tsMs: Date.UTC(2026, 8, 1) + Math.floor(n / SEQUENCE_COUNT),
      bucket,
      nodeId: 1,
      sequence: n % SEQUENCE_COUNT,
    });
  }
}
