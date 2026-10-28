import { ApiProperty } from '@nestjs/swagger';
import { IsInt, NotEquals } from 'class-validator';

/**
 * Not idempotent by nature, which is exactly why it is a POST and `PUT` carries the absolute value:
 * a client that cannot tell whether its request landed should re-read and set, not re-add.
 */
export class AdjustStockDto {
  @ApiProperty({ example: 25, description: 'Signed change in units; 0 is rejected as a no-op' })
  @IsInt()
  @NotEquals(0)
  delta!: number;
}
