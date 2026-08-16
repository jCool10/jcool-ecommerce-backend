import type { INestApplication } from '@nestjs/common';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';

// Direct inserts (mirroring catalog.fixture / seed.ts) so a fixture doesn't depend
// on a write API that doesn't exist yet.

export interface SeededStock {
  variantId: string;
  onHand: number;
  reserved: number;
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
