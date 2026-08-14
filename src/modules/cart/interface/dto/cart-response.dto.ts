import { ApiProperty } from '@nestjs/swagger';
import type { CartView } from '../../application/cart.service';

/** One cart line with its live (not frozen) Catalog price at read time. */
export class CartLineResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Product-variant id (SKU)' })
  skuId!: string;

  @ApiProperty({ example: 'Wireless Headphones / Black' })
  productName!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 199000,
    description: 'Live unit price in minor units; null if the SKU is unpriced',
  })
  unitPriceMinor!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 398000,
    description: 'unitPriceMinor × quantity; null if the SKU is unpriced',
  })
  lineTotalMinor!: number | null;

  @ApiProperty({ example: true, description: 'Product is ACTIVE and the variant is not archived' })
  isActive!: boolean;
}

/** The user's cart: lines + a subtotal summed from live prices. */
export class CartResponseDto {
  @ApiProperty({ type: [CartLineResponseDto] })
  items!: CartLineResponseDto[];

  @ApiProperty({
    example: 398000,
    description:
      'Sum of live line totals (minor units). Gross of availability — inactive/archived lines are included; Order re-validates at checkout.',
  })
  subtotalMinor!: number;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  static fromView(view: CartView): CartResponseDto {
    return {
      items: view.items.map((line) => ({ ...line })),
      subtotalMinor: view.subtotalMinor,
      currency: view.currency,
    };
  }
}
