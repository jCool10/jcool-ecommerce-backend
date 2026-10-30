import { ArrayMaxSize, ArrayNotEmpty, IsArray } from 'class-validator';
import { MAX_STATUS_BATCH, type PaymentStatusBody } from '@jcool/internal-contracts';
import { IsSnowflakeId } from '@jcool/platform/interface';

export class PaymentStatusDto implements PaymentStatusBody {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_STATUS_BATCH)
  @IsSnowflakeId({ each: true })
  orderIds!: string[];
}
