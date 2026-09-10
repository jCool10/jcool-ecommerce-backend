import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';

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

/** `available` is the invariant a race must keep >= 0. */
export async function getStockView(app: INestApplication, variantId: string): Promise<StockView | null> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db
    .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.variantId, variantId));
  if (!row) return null;
  return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}

/** Must equal the number of winning holds after a race. */
export async function countHeldReservations(app: INestApplication, variantId: string): Promise<number> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const rows = await db
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.variantId, variantId), eq(schema.reservations.status, 'HELD')));
  return rows.length;
}
