import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { CartItem } from '../domain/cart-item.entity';
import type { CartRepositoryPort } from '../application/ports/cart-repository.port';
import { cartItems, carts } from './schema/cart.schema';

/**
 * Drizzle adapter for CartRepositoryPort. Accumulate-on-add is a single upsert
 * on the (cartId, skuId) unique index — race-safe without a read-modify-write.
 */
@Injectable()
export class DrizzleCartRepository implements CartRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async ensureCartId(userId: string): Promise<string> {
    // Read-first get-or-create: the common case (cart already exists) is a single
    // SELECT with no write, so a plain GET /cart never mutates the DB. Only a
    // first-time user reaches the INSERT. Still race-safe — a lost insert race
    // (ON CONFLICT DO NOTHING returns no row) falls through to the re-read.
    const found = await this.selectCartId(userId);
    if (found) {
      return found;
    }
    const [created] = await this.db
      .insert(carts)
      .values({ userId })
      .onConflictDoNothing({ target: carts.userId })
      .returning({ id: carts.id });
    if (created) {
      return created.id;
    }
    const existing = await this.selectCartId(userId);
    if (!existing) {
      throw new Error(`Cart could not be ensured for user ${userId}`);
    }
    return existing;
  }

  private async selectCartId(userId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: carts.id }).from(carts).where(eq(carts.userId, userId)).limit(1);
    return row?.id ?? null;
  }

  async findItems(cartId: string): Promise<CartItem[]> {
    const rows = await this.db
      .select({ skuId: cartItems.skuId, quantity: cartItems.quantity })
      .from(cartItems)
      .where(eq(cartItems.cartId, cartId))
      .orderBy(cartItems.createdAt, cartItems.id);
    return rows.map((row) => CartItem.of(row.skuId, row.quantity));
  }

  async addItem(cartId: string, skuId: string, quantity: number): Promise<void> {
    await this.db
      .insert(cartItems)
      .values({ cartId, skuId, quantity })
      // Accumulate onto the existing line. $onUpdate doesn't fire on a conflict
      // SET, so bump updated_at by hand (parity with catalog price upsert).
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.skuId],
        set: { quantity: sql`${cartItems.quantity} + ${quantity}`, updatedAt: new Date() },
      });
  }

  async setItemQuantity(cartId: string, skuId: string, quantity: number): Promise<boolean> {
    const updated = await this.db
      .update(cartItems)
      .set({ quantity })
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.skuId, skuId)))
      .returning({ id: cartItems.id });
    return updated.length > 0;
  }

  async removeItem(cartId: string, skuId: string): Promise<void> {
    await this.db.delete(cartItems).where(and(eq(cartItems.cartId, cartId), eq(cartItems.skuId, skuId)));
  }

  async clear(cartId: string): Promise<void> {
    await this.db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  }
}
