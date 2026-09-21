import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BUCKET_COUNT, SEQUENCE_COUNT } from '@jcool/id-codec';

/**
 * One node-millisecond per request. A node can stamp `SEQUENCE_COUNT` ids inside a millisecond;
 * past that the generator busy-waits for the next one, and a larger batch would block the event
 * loop for as many milliseconds as it overflows. Every caller mints one id at a time.
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
