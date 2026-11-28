import { Inject, Injectable } from '@nestjs/common';
import { CART_SNAPSHOT, type CartSnapshotReader } from '../../cart/application/public/cart-snapshot.port';
import type { CartSnapshotReaderPort, OrderCartLine } from '../application/ports/cart-snapshot.port';

@Injectable()
export class CartSnapshotLocalAdapter implements CartSnapshotReaderPort {
  constructor(@Inject(CART_SNAPSHOT) private readonly cart: CartSnapshotReader) {}

  async getLines(userId: string): Promise<OrderCartLine[]> {
    const lines = await this.cart.getLines(userId);
    return lines.map(({ skuId, quantity }) => ({ skuId, quantity }));
  }
}
