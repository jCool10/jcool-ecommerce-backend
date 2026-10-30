import { ArrayMaxSize, ArrayNotEmpty, IsArray } from 'class-validator';
import { MAX_STATUS_BATCH, type StatusBody } from '@jcool/internal-contracts';
import { IsSnowflakeId } from '@jcool/platform/interface';

export class StatusDto implements StatusBody {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_STATUS_BATCH)
  @IsSnowflakeId({ each: true })
  orderIds!: string[];
}
