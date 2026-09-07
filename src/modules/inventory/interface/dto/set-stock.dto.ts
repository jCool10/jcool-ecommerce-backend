import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/** Absolute on-hand for one SKU. Idempotent: the same body applied twice leaves the same level. */
export class SetStockDto {
  @ApiProperty({ example: 40, minimum: 0, description: 'Units physically on hand (integer)' })
  @IsInt()
  @Min(0)
  quantityOnHand!: number;
}
