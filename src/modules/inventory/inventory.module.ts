import { Module } from '@nestjs/common';
import { STOCK_ADMIN } from './application/ports/stock-admin.port';
import { STOCK_REPOSITORY } from './application/ports/stock-repository.port';
import { STOCK_RESERVATION } from './application/public/stock-reservation.port';
import { AdjustStockUseCase } from './application/adjust-stock.use-case';
import { ReserveStockUseCase } from './application/reserve-stock.use-case';
import { StockAdminRepository } from './infrastructure/stock-admin.repository';
import { StockRepository } from './infrastructure/stock.repository';
import { AdminInventoryController } from './interface/admin-inventory.controller';

/**
 * Inventory bounded context: the "never oversell" invariant. Owns stock levels +
 * reservations behind STOCK_REPOSITORY; ReserveStockUseCase picks the locking
 * strategy from config and dispatches to the port. `STOCK_RESERVATION` is Inventory's
 * published language, exported so the order flow can hold stock inside its place-order
 * transaction. No cross-context imports — the only references out are
 * `variantId`/`orderId` as plain ids.
 *
 * STOCK_ADMIN is the operator's write side, deliberately NOT exported: setting stock outright is not
 * something another context may do on a buyer's behalf.
 */
@Module({
  controllers: [AdminInventoryController],
  providers: [
    ReserveStockUseCase,
    AdjustStockUseCase,
    { provide: STOCK_REPOSITORY, useClass: StockRepository },
    { provide: STOCK_ADMIN, useClass: StockAdminRepository },
    { provide: STOCK_RESERVATION, useExisting: ReserveStockUseCase },
  ],
  exports: [STOCK_RESERVATION, STOCK_REPOSITORY],
})
export class InventoryModule {}
