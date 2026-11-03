import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_STOCK_ON_HAND } from '../../domain/stock-limits';

export class SetStockDto {
  @ApiProperty({
    example: 40,
    minimum: 0,
    maximum: MAX_STOCK_ON_HAND,
    description: 'Units physically on hand (integer)',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK_ON_HAND)
  quantityOnHand!: number;
}
