import { Module } from '@nestjs/common';
import { STOCK_REPOSITORY } from './application/ports/stock-repository.port';
import { STOCK_RESERVATION } from './application/public/stock-reservation.port';
import { ReserveStockUseCase } from './application/reserve-stock.use-case';
import { StockRepository } from './infrastructure/stock.repository';

/**
 * Inventory bounded context: the "never oversell" invariant. Owns stock levels +
 * reservations behind STOCK_REPOSITORY; ReserveStockUseCase picks the locking
 * strategy from config and dispatches to the port. `STOCK_RESERVATION` is Inventory's
 * published language, exported so the order flow can hold stock inside its place-order
 * transaction. No cross-context imports — the only references out are
 * `variantId`/`orderId` as plain ids.
 */
@Module({
  providers: [
    ReserveStockUseCase,
    { provide: STOCK_REPOSITORY, useClass: StockRepository },
    { provide: STOCK_RESERVATION, useExisting: ReserveStockUseCase },
  ],
  exports: [STOCK_RESERVATION, STOCK_REPOSITORY],
})
export class InventoryModule {}
