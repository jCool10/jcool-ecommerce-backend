import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, NotEquals } from 'class-validator';
import { MAX_STOCK_ON_HAND } from '../../domain/stock-limits';

/**
 * Not idempotent by nature, which is exactly why it is a POST and `PUT` carries the absolute value:
 * a client that cannot tell whether its request landed should re-read and set, not re-add.
 */
export class AdjustStockDto {
  @ApiProperty({
    example: 25,
    minimum: -MAX_STOCK_ON_HAND,
    maximum: MAX_STOCK_ON_HAND,
    description: 'Signed change in units; 0 is rejected as a no-op',
  })
  @IsInt()
  @Min(-MAX_STOCK_ON_HAND)
  @Max(MAX_STOCK_ON_HAND)
  @NotEquals(0)
  delta!: number;
}
