import { Inject, Injectable } from '@nestjs/common';
import {
  PRODUCT_STOCK_RESERVATION,
  type ProductStockReservation,
} from '@modules/product/application/public/product-stock-reservation.port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  InventoryReservationPort,
  ReservationLine,
  StockResolution,
} from '../application/ports/inventory-reservation.port';

// The only place Order touches Product's stock, and only through its `application/public` surface.
// Order's `skuId` maps to the variant id stock is held by, and the caller's `tx` flows through so
// the hold joins the placement transaction.
@Injectable()
export class InventoryReservationAdapter implements InventoryReservationPort {
  constructor(
    @Inject(PRODUCT_STOCK_RESERVATION)
    private readonly stock: ProductStockReservation,
  ) {}

  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void> {
    return this.stock.reserve(
      tx,
      orderId,
      lines.map((line) => ({ variantId: line.skuId, quantity: line.quantity })),
    );
  }

  // Reservations are keyed by orderId, so resolution needs no skuId → variantId mapping.
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolution> {
    return this.stock.commit(tx, orderId);
  }

  release(tx: DrizzleTx, orderId: string): Promise<StockResolution> {
    return this.stock.release(tx, orderId);
  }

  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]> {
    return this.stock.findExpiredHolds(query);
  }
}
