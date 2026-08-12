import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PRODUCT_STATUSES, type ProductStatus } from '../../domain/entities/product.entity';
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

  @ApiProperty({ example: 'clx0abc123...', description: 'Category id (cuid2) — must exist and be active' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
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
