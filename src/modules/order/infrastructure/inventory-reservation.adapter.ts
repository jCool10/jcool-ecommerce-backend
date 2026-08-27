import { Inject, Injectable } from '@nestjs/common';
import { STOCK_RESERVATION, type StockReservation } from '@modules/inventory/application/public/stock-reservation.port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  InventoryReservationPort,
  ReservationLine,
  StockResolution,
} from '../application/ports/inventory-reservation.port';

/**
 * Anti-corruption adapter: implements Order's `InventoryReservationPort` by
 * delegating to Inventory's published `STOCK_RESERVATION`. The ONLY place Order
 * touches Inventory, importing just its `application/public` surface. Maps Order's
 * `skuId` to the variant id Inventory holds stock by; the caller's `tx` flows through
 * so the hold joins the placement transaction. `StockReservationError` propagates.
 */
@Injectable()
export class InventoryReservationAdapter implements InventoryReservationPort {
  constructor(
    @Inject(STOCK_RESERVATION)
    private readonly stock: StockReservation,
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
