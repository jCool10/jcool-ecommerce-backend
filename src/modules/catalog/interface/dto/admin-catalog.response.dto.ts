import { ApiProperty } from '@nestjs/swagger';
import {
  PRODUCT_STATUSES,
  type AdminProduct,
  type Category,
  type Price,
  type ProductImage,
  type Sku,
} from '../../domain/entities';

// Response shapes for the admin write paths, always mapped via `fromEntity` so DB
// internals never leak. `archivedAt` is a nullable ISO string (null = active).

export class AdminCategoryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  parentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Null = active; set = archived' })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static fromEntity(category: Category): AdminCategoryResponseDto {
    const dto = new AdminCategoryResponseDto();
    dto.id = category.id;
    dto.name = category.name;
    dto.slug = category.slug;
    dto.parentId = category.parentId;
    dto.archivedAt = category.archivedAt ? category.archivedAt.toISOString() : null;
    dto.createdAt = category.createdAt.toISOString();
    return dto;
  }
}

export class AdminProductResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: PRODUCT_STATUSES })
  status!: string;

  @ApiProperty()
  categoryId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static fromEntity(product: AdminProduct): AdminProductResponseDto {
    const dto = new AdminProductResponseDto();
    dto.id = product.id;
    dto.name = product.name;
    dto.slug = product.slug;
    dto.description = product.description;
    dto.status = product.status;
    dto.categoryId = product.categoryId;
    dto.createdAt = product.createdAt.toISOString();
    return dto;
  }
}

export class AdminSkuResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'WH-BLK' })
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Null = active; set = archived' })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static fromEntity(sku: Sku): AdminSkuResponseDto {
    const dto = new AdminSkuResponseDto();
    dto.id = sku.id;
    dto.sku = sku.sku;
    dto.name = sku.name;
    dto.productId = sku.productId;
    dto.archivedAt = sku.archivedAt ? sku.archivedAt.toISOString() : null;
    dto.createdAt = sku.createdAt.toISOString();
    return dto;
  }
}

export class AdminProductImageResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  assetId!: string;

  @ApiProperty({ description: 'Display slot, ascending' })
  position!: number;

  @ApiProperty({ type: String, nullable: true })
  alt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static fromEntity(image: ProductImage): AdminProductImageResponseDto {
    const dto = new AdminProductImageResponseDto();
    dto.id = image.id;
    dto.productId = image.productId;
    dto.assetId = image.assetId;
    dto.position = image.position;
    dto.alt = image.alt;
    dto.createdAt = image.createdAt.toISOString();
    return dto;
  }
}

export class AdminPriceResponseDto {
  @ApiProperty()
  variantId!: string;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({ example: 2490000, description: 'Amount in minor units (int)' })
  amountMinor!: number;

  static fromEntity(price: Price): AdminPriceResponseDto {
    const dto = new AdminPriceResponseDto();
    dto.variantId = price.variantId;
    dto.currency = price.currency;
    dto.amountMinor = price.amountMinor;
    return dto;
  }
}
