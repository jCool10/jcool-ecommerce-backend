import { Module } from '@nestjs/common';
import { CallerTokenGuard } from '@jcool/platform/internal-api';
import { InventoryParticipantService } from './application/inventory-participant.service';
import { STOCK_ADMIN } from './application/ports/stock-admin.port';
import { STOCK_REPOSITORY } from './application/ports/stock-repository.port';
import { INVENTORY_PARTICIPANT } from './application/public/inventory-participant.port';
import { ReleaseLapsedHoldsUseCase } from './application/release-lapsed-holds.use-case';
import { StockAdminService } from './application/stock-admin.service';
import { IdentityModule } from './identity.module';
import { StockAdminRepository } from './infrastructure/stock-admin.repository';
import { StockRepository } from './infrastructure/stock.repository';
import { AdminInventoryController } from './interface/admin-inventory.controller';
import { ReservationsController } from './interface/internal/reservations.controller';
import { LapsedHoldSweepScheduler } from './interface/lapsed-hold-sweep.scheduler';

@Module({
  imports: [IdentityModule],
  controllers: [ReservationsController, AdminInventoryController],
  providers: [
    StockAdminService,
    { provide: STOCK_REPOSITORY, useClass: StockRepository },
    { provide: STOCK_ADMIN, useClass: StockAdminRepository },
    InventoryParticipantService,
    { provide: INVENTORY_PARTICIPANT, useExisting: InventoryParticipantService },
    ReleaseLapsedHoldsUseCase,
    LapsedHoldSweepScheduler,
    // A provider, not just a route guard, so a service with no caller token fails at boot.
    CallerTokenGuard,
  ],
})
export class InventoryModule {}
