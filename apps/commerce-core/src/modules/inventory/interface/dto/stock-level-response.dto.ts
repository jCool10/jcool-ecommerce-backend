import { ApiProperty } from '@nestjs/swagger';
import type { StockView } from '../../application/ports/stock-admin.port';

export class StockLevelResponseDto {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ example: 40 })
  quantityOnHand!: number;

  @ApiProperty({ example: 3, description: 'Units held by orders that have not settled yet' })
  quantityReserved!: number;

  @ApiProperty({ example: 37, description: 'on hand − reserved: what a new order can still take' })
  available!: number;

  static fromView(variantId: string, view: StockView): StockLevelResponseDto {
    return {
      variantId,
      quantityOnHand: view.onHand,
      quantityReserved: view.reserved,
      available: view.available,
    };
  }
}
