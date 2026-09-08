import { Inject, Injectable } from '@nestjs/common';
import { CART_SNAPSHOT, type CartSnapshotReader } from '@modules/cart/application/public/cart-snapshot.port';
import type { CartSnapshotReaderPort, OrderCartLine } from '../application/ports/cart-snapshot.port';

// The only place Order touches Cart, and only through Cart's `application/public` surface.
@Injectable()
export class CartSnapshotAdapter implements CartSnapshotReaderPort {
  constructor(
    @Inject(CART_SNAPSHOT)
    private readonly cart: CartSnapshotReader,
  ) {}

  async getLines(userId: string): Promise<OrderCartLine[]> {
    const lines = await this.cart.getLines(userId);
    return lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity }));
  }
}
