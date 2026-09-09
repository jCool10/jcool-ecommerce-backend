import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { MAX_LINE_QUANTITY } from '../cart.constants';
import { DrizzleCartRepository } from './drizzle-cart.repository';

// Renders the ON CONFLICT SET expression addItem builds, so the ceiling can be asserted on the
// statement itself — a read-modify-write check in JS would not be race-safe and isn't what runs.
async function renderConflictQuantity(quantity: number): Promise<{ sql: string; params: unknown[] }> {
  let captured: SQL | undefined;
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (config: { set: { quantity: SQL } }) => {
          captured = config.set.quantity;
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as DrizzleDB;

  await new DrizzleCartRepository(db).addItem('cart-1', 'sku-1', quantity);
  if (!captured) {
    throw new Error('addItem did not build an ON CONFLICT quantity expression');
  }
  return new PgDialect().sqlToQuery(captured);
}

describe('DrizzleCartRepository.addItem', () => {
  it('clamps the accumulated line quantity at the cap in the upsert itself', async () => {
    const { sql, params } = await renderConflictQuantity(7);

    expect(sql).toBe('LEAST("cart_items"."quantity" + $1, $2)');
    expect(params).toEqual([7, MAX_LINE_QUANTITY]);
  });
});
