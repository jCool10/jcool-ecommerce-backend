import { SEQUENCE_COUNT, encode } from '@jcool/id-codec';
import type { IdGeneratorPort } from '@shared/identity/id-generator.port';

/** A fixed, routable id, distinct per `n`. */
export function sampleId(n = 0): string {
  return encode({
    tsMs: Date.UTC(2026, 8, 1) + Math.floor(n / SEQUENCE_COUNT),
    nodeId: 1,
    sequence: n % SEQUENCE_COUNT,
  });
}

/** Mints distinct routable ids. */
export class RecordingIdGenerator implements IdGeneratorPort {
  private minted = 0;

  mint(count = 1): Promise<string[]> {
    return Promise.resolve(Array.from({ length: count }, () => sampleId(this.minted++)));
  }
}
