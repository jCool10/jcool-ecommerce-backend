import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { CatalogSkuSeed, SeededSku } from '@jcool/internal-contracts/testing';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from './bearer.helper';
import { createTestProduct } from './fixtures/catalog.fixture';
import { createTestPrincipal } from './fixtures/principal.fixture';

/**
 * Returns the supertest chain so a caller can assert on the response body, but the 200 is baked in:
 * this is an arrangement step, never the subject.
 */
export function addToCart(app: INestApplication, token: string, skuId: string, quantity = 1): request.Test {
  return request(app.getHttpServer()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity }).expect(200);
}

/** A fresh buyer whose cart a buyer could have built: every line goes through `POST /cart/items`. */
export async function seedCart(app: INestApplication, lines: { skuId: string; quantity: number }[]): Promise<string> {
  const { user, accessToken } = await createTestPrincipal(app);
  for (const { skuId, quantity } of lines) {
    await addToCart(app, accessToken, skuId, quantity);
  }
  return user.id;
}

export async function seedCatalogSku(app: INestApplication, seed: CatalogSkuSeed): Promise<SeededSku> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const product = await createTestProduct(app, {
    status: seed.productStatus,
    ...(seed.priceMinor === null ? {} : { priceMinor: seed.priceMinor }),
  });
  if (seed.priceMinor === null) {
    await db.delete(schema.prices).where(eq(schema.prices.variantId, product.variantId));
  }
  if (seed.variantArchived) {
    await db
      .update(schema.productVariants)
      .set({ archivedAt: new Date() })
      .where(eq(schema.productVariants.id, product.variantId));
  }
  return { skuId: product.variantId, productName: product.name };
}
