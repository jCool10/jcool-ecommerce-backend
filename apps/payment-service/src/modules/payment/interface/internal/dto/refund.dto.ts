import type { RefundBody } from '@jcool/internal-contracts';
import { IsSnowflakeId } from '@jcool/platform/interface';

export class RefundDto implements RefundBody {
  @IsSnowflakeId()
  requestedBy!: string;
}
