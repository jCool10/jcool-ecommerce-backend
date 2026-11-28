import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { IsSnowflakeId } from '@jcool/platform/interface';
import { MAX_LINE_QUANTITY } from '../../cart.constants';

export class AddCartItemDto {
  @ApiProperty({ example: '137465797020397179', description: 'Product-variant id (SKU) to add' })
  @IsSnowflakeId()
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
