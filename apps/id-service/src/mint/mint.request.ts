import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BUCKET_COUNT } from '@jcool/id-codec';

export const MAX_IDS_PER_REQUEST = 1_000;

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
