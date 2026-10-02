import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsSnowflakeId } from '@jcool/platform/interface';
import { PRODUCT_STATUSES, type ProductStatus } from '../../../domain/catalog/entities';
import { SLUG_MESSAGE, SLUG_PATTERN } from './create-category.dto';

export class CreateProductDto {
  @ApiProperty({ example: 'Wireless Headphones', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'wireless-headphones', description: 'URL-safe unique slug' })
  @IsString()
  @MaxLength(200)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: '137465797020397179', description: 'Category id — must exist and be active' })
  @IsSnowflakeId()
  categoryId!: string;

  @ApiPropertyOptional({
    enum: PRODUCT_STATUSES,
    default: 'DRAFT',
    description: "Publish state. New products default to DRAFT; set 'ACTIVE' to expose on the public read.",
  })
  @IsOptional()
  @IsIn(PRODUCT_STATUSES)
  status?: ProductStatus;
}
