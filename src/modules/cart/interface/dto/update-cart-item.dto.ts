import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

// Same per-line cap as add (keeps quantity inside int4 + JS safe-integer range).
const MAX_QUANTITY = 10_000;

/** Set a cart line's absolute quantity (replaces, not accumulates). */
export class UpdateCartItemDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: MAX_QUANTITY,
    description: 'New absolute quantity (integer 1..10000)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY)
  quantity!: number;
}
