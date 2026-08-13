import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** A SKU is a ProductVariant — `sku` is globally unique (a duplicate anywhere, not just within the product, is a 409); just code + display name. */
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
