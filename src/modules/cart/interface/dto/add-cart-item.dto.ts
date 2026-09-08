import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

// Per-line quantity cap: keeps a request-supplied `quantity` well inside int4 and JS safe-integer
// range, so out-of-range input is a clean 400 at the edge instead of a Postgres overflow
// surfacing as a 500.
const MAX_QUANTITY = 10_000;

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid', description: 'Product-variant id (SKU) to add' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_QUANTITY, description: 'Units to add (integer 1..10000)' })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY)
  quantity!: number;
}
