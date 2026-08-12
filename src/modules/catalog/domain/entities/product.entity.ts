import { Money } from '../../../../shared/kernel';

// Catalog domain entities — pure, no framework/DB imports. Price is the shared
// `Money` value object (integer smallest-unit, currency-checked), replacing the
// old per-context `ProductPrice` interface so cross-currency mistakes are
// impossible by construction.

// Single source for the status vocabulary (a DTO can @IsIn it, Swagger can
// enumerate it). Mirrors the Drizzle `product_status` pgEnum.
export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  prices: Money[];
}

export interface ProductCategory {
  slug: string;
  name: string;
}

export class Product {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly description: string | null,
    public readonly status: ProductStatus,
    public readonly category: ProductCategory,
    public readonly variants: ProductVariant[],
    public readonly createdAt: Date,
  ) {}
}
