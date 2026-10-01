import { SEQUENCE_COUNT, encode } from '@jcool/id-codec';
import type { IdGeneratorPort } from '../application/ports';

/** Mints routable ids and records the count of every request. */
export class RecordingIdGenerator implements IdGeneratorPort {
  readonly requests: number[] = [];
  private minted = 0;

  mint(count = 1): Promise<string[]> {
    this.requests.push(count);
    return Promise.resolve(Array.from({ length: count }, () => this.next()));
  }

  private next(): string {
    const n = this.minted++;
    return encode({
      tsMs: Date.UTC(2026, 8, 1) + Math.floor(n / SEQUENCE_COUNT),
      nodeId: 1,
      sequence: n % SEQUENCE_COUNT,
    });
  }
}
