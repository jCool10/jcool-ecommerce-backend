import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from '../../cart.constants';

export class UpdateCartItemDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description: `New absolute quantity (integer 1..${MAX_LINE_QUANTITY}).`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
