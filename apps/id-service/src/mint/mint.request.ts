import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BUCKET_COUNT, SEQUENCE_COUNT } from '@jcool/id-codec';

/**
 * One node-millisecond per request. A node can stamp `SEQUENCE_COUNT` ids inside a millisecond and
 * then busy-waits for the next one, so a request this size blocks the event loop at most once, for
 * up to about 1 ms; a larger one would block a millisecond per overflow. Every caller mints one id.
 */
export const MAX_IDS_PER_REQUEST = SEQUENCE_COUNT;

export class MintRequest {
  @IsInt()
  @Min(0)
  @Max(BUCKET_COUNT - 1)
  bucket!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_IDS_PER_REQUEST)
  count: number = 1;
}

export interface MintResponse {
  ids: string[];
}
