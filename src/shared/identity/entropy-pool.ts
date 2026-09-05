import { Buffer } from 'node:buffer';
import { randomFillSync } from 'node:crypto';

const DEFAULT_POOL_BYTES = 5120;
// Widest draw `readUIntBE` can serve; a smaller pool would refill every `take` and still read past
// its own end.
const MAX_DRAW_BYTES = 6;

/**
 * Pre-drawn CSPRNG bytes handed out as integers, so id generation pays one `randomFillSync` per
 * ~1000 ids. `take` returns a number, not a view — a view would be overwritten by the next refill
 * while the caller still held it.
 */
export class EntropyPool {
  private readonly pool: Buffer;
  private offset = 0;

  constructor(sizeBytes: number = DEFAULT_POOL_BYTES) {
    if (!Number.isInteger(sizeBytes) || sizeBytes < MAX_DRAW_BYTES) {
      throw new RangeError(`EntropyPool size must be an integer of at least ${MAX_DRAW_BYTES} bytes`);
    }
    this.pool = randomFillSync(Buffer.allocUnsafe(sizeBytes));
  }

  take(byteCount: number): number {
    // Refill on a whole-draw boundary: `readUIntBE` cannot span a refill, and stitching two halves
    // buys nothing over discarding the few leftover bytes.
    if (this.offset + byteCount > this.pool.length) {
      randomFillSync(this.pool);
      this.offset = 0;
    }

    const value = this.pool.readUIntBE(this.offset, byteCount);
    this.offset += byteCount;
    return value;
  }
}
