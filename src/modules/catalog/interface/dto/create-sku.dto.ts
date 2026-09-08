import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** A SKU is a ProductVariant; a duplicate `sku` anywhere, not just within the product, is a 409. */
export class CreateSkuDto {
  @ApiProperty({ example: 'WH-BLK', description: 'Globally-unique SKU code' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: 'Wireless Headphones / Black', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}
