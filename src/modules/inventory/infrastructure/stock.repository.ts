import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import type { ReserveLine, StockRepositoryPort, StockView } from '../application/ports/stock-repository.port';
import { stockLevels } from './schema/inventory.schema';

/**
 * Drizzle adapter for StockRepositoryPort. `getStockView` is a plain read. The two
 * reserve strategies are left as explicit `NotImplemented` seams so nothing silently
 * no-ops before the locking is real; both take the caller's `tx` so the hold commits
 * or rolls back with the order.
 */
@Injectable()
export class StockRepository implements StockRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  reservePessimistic(_tx: DrizzleTx, _orderId: string, _lines: ReserveLine[]): Promise<void> {
    throw new NotImplementedException('Pessimistic reserve not yet implemented');
  }

  reserveOptimistic(_tx: DrizzleTx, _orderId: string, _lines: ReserveLine[]): Promise<void> {
    throw new NotImplementedException('Optimistic reserve not yet implemented');
  }

  async getStockView(variantId: string): Promise<StockView | null> {
    const [row] = await this.db
      .select({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved })
      .from(stockLevels)
      .where(eq(stockLevels.variantId, variantId))
      .limit(1);
    if (!row) {
      return null;
    }
    return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
  }
}
