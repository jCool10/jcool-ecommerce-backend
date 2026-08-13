import { ApiProperty } from '@nestjs/swagger';
import type { Product } from '../../domain/entities';

// Product response shape. Always mapped from the domain entity via `fromEntity`
// so DB internals never leak. Money stays integer `amountMinor`.

export class PriceResponseDto {
  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({ example: 2490000, description: 'Amount in minor units (int)' })
  amountMinor!: number;
}

export class VariantResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'WH-BLK' })
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: [PriceResponseDto] })
  prices!: PriceResponseDto[];
}

export class CategoryResponseDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
}

export class ProductResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ type: CategoryResponseDto })
  category!: CategoryResponseDto;

  @ApiProperty({ type: [VariantResponseDto] })
  variants!: VariantResponseDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static fromEntity(product: Product): ProductResponseDto {
    const dto = new ProductResponseDto();
    dto.id = product.id;
    dto.name = product.name;
    dto.slug = product.slug;
    dto.description = product.description;
    dto.status = product.status;
    dto.category = {
      slug: product.category.slug,
      name: product.category.name,
    };
    dto.variants = product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      prices: variant.prices.map((price) => ({
        currency: price.currency,
        amountMinor: price.amountMinor,
      })),
    }));
    dto.createdAt = product.createdAt.toISOString();
    return dto;
  }
}
