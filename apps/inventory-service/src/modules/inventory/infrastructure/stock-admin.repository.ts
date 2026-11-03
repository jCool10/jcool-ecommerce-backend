import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { isCheckViolation } from '@jcool/platform/database';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '../application/ports/id-generator.port';
import type { StockAdminPort, StockView } from '../application/ports/stock-admin.port';
import { MAX_STOCK_ON_HAND } from '../domain/stock-limits';
import { stockLevels } from './schema/stock.schema';

// The two data-layer invariants an operator write can hit. Both come back as 409 rather than 500:
// the request was well formed, the current stock is simply not compatible with it.
const NO_OVERSELL = 'ck_stock_no_oversell';
const ON_HAND_NONNEG = 'ck_stock_on_hand_nonneg';

/**
 * Both writes are single statements — never read-modify-write — because they race the reservation
 * CAS in stock.repository.ts, which raises `quantity_reserved` under no lock these statements take
 * part in.
 *
 * Written through Drizzle, not raw SQL: `updated_at` moves via `$onUpdate`, so a raw UPDATE would
 * leave the stamp behind.
 */
@Injectable()
export class StockAdminRepository implements StockAdminPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
  ) {}

  async getLevel(variantId: string): Promise<StockView | null> {
    const [row] = await this.db
      .select({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved })
      .from(stockLevels)
      .where(eq(stockLevels.variantId, variantId))
      .limit(1);
    return row ? toView(row) : null;
  }

  async setOnHand(variantId: string, quantity: number): Promise<StockView> {
    // Wasted when the row already exists; minting only on a miss would need a second round trip.
    const id = await mintOne(this.idGenerator);
    const [row] = await this.guardChecks(() =>
      this.db
        .insert(stockLevels)
        .values({ id, variantId, quantityOnHand: quantity })
        .onConflictDoUpdate({
          target: stockLevels.variantId,
          set: {
            quantityOnHand: quantity,
            version: sql`${stockLevels.version} + 1`,
            // `$onUpdate` covers `.update()`, not the conflict branch of an upsert, so the stamp is
            // set here or it never moves.
            updatedAt: new Date(),
          },
        })
        .returning({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved }),
    );
    return toView(row);
  }

  async adjust(variantId: string, delta: number): Promise<StockView | null> {
    const [row] = await this.guardChecks(() =>
      this.db
        .update(stockLevels)
        .set({
          // The addition happens in the database, so a receipt landing during a reservation keeps
          // both: reading the value into JS first would overwrite whatever the CAS just wrote.
          quantityOnHand: sql`${stockLevels.quantityOnHand} + ${delta}`,
          version: sql`${stockLevels.version} + 1`,
        })
        // The ceiling is in the statement, not a prior read, so concurrent adjustments cannot jointly pass it.
        .where(
          and(
            eq(stockLevels.variantId, variantId),
            sql`${stockLevels.quantityOnHand} + ${delta} <= ${MAX_STOCK_ON_HAND}`,
          ),
        )
        .returning({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved }),
    );
    if (row) return toView(row);
    // No row: either the level does not exist, or the ceiling refused the change.
    if (await this.getLevel(variantId)) {
      throw new ConflictException(`Stock level must stay at or below ${MAX_STOCK_ON_HAND}`);
    }
    return null;
  }

  private async guardChecks<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      // A write can break both at once (on-hand below zero with nothing reserved), and Postgres names
      // only the first alphabetically — the oversell one. Hence a message covering both bounds.
      if (isCheckViolation(error, NO_OVERSELL)) {
        throw new ConflictException('Stock level must stay at or above zero and at or above the quantity reserved', {
          cause: error,
        });
      }
      if (isCheckViolation(error, ON_HAND_NONNEG)) {
        throw new ConflictException('Stock level would fall below zero', { cause: error });
      }
      throw error;
    }
  }
}

function toView(row: { onHand: number; reserved: number }): StockView {
  return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}
