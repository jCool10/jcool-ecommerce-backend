import { ApiProperty } from '@nestjs/swagger';
import { ORDER_STATUSES, OrderStatus } from '../../domain/order-status';
import type { OrderView } from '../../application/order-view.mapper';

export class OrderItemResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Product-variant id (SKU)' })
  skuId!: string;

  @ApiProperty({ example: 'Wireless Headphones / Black', description: 'Name snapshotted at creation' })
  productName!: string;

  @ApiProperty({ example: 199000, description: 'Unit price (minor units) snapshotted at creation' })
  unitPriceMinor!: number;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 398000, description: 'unitPriceMinor × quantity' })
  lineTotalMinor!: number;
}

export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ORDER_STATUSES, example: OrderStatus.DRAFT })
  status!: OrderStatus;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({
    example: 398000,
    description: 'Snapshot total (minor units). Frozen at creation — a later Catalog price change never alters it.',
  })
  totalAmountMinor!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Set when the order is placed (DRAFT → PENDING); null while still a draft.',
  })
  placedAt!: string | null;

  @ApiProperty({ type: [OrderItemResponseDto] })
  items!: OrderItemResponseDto[];

  static fromView(view: OrderView): OrderResponseDto {
    return {
      id: view.id,
      status: view.status,
      currency: view.currency,
      totalAmountMinor: view.totalAmountMinor,
      placedAt: view.placedAt,
      items: view.items.map((line) => ({ ...line })),
    };
  }
}
