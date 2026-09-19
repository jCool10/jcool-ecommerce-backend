import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from '../../cart.constants';

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid', description: 'Product-variant id (SKU) to add' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description: `Units to add (integer 1..${MAX_LINE_QUANTITY}). Adds accumulate, and the line is clamped at ${MAX_LINE_QUANTITY}.`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
