import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';

// Direct inserts (mirroring catalog.fixture / seed.ts) so a fixture doesn't depend
// on a write API that doesn't exist yet.

export interface SeededStock {
  variantId: string;
  onHand: number;
  reserved: number;
}

export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * Seed (or reset) one SKU's stock row so a test can set an exact on-hand. Upserts on
 * `variantId` (unique) — safe to call repeatedly for the same SKU within a test.
 */
export async function seedStock(
  app: INestApplication,
  variantId: string,
  onHand: number,
  reserved = 0,
): Promise<SeededStock> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db
    .insert(schema.stockLevels)
    .values({ variantId, quantityOnHand: onHand, quantityReserved: reserved })
    .onConflictDoUpdate({
      target: schema.stockLevels.variantId,
      set: { quantityOnHand: onHand, quantityReserved: reserved },
    });
  return { variantId, onHand, reserved };
}

/** Current stock for a SKU, with `available` derived — the invariant a race must keep >= 0. */
export async function getStockView(app: INestApplication, variantId: string): Promise<StockView | null> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db
    .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.variantId, variantId));
  if (!row) return null;
  return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}

/** How many HELD reservations exist for a SKU — must equal the number of winning holds after a race. */
export async function countHeldReservations(app: INestApplication, variantId: string): Promise<number> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const rows = await db
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.variantId, variantId), eq(schema.reservations.status, 'HELD')));
  return rows.length;
}
