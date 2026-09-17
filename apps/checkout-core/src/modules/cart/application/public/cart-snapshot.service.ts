import { Inject, Injectable } from '@nestjs/common';
import { CART_REPOSITORY, type CartRepositoryPort } from '../ports/cart-repository.port';
import type { CartSnapshotLine, CartSnapshotReader } from './cart-snapshot.port';

@Injectable()
export class CartSnapshotService implements CartSnapshotReader {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repo: CartRepositoryPort,
  ) {}

  async getLines(userId: string): Promise<CartSnapshotLine[]> {
    const cartId = await this.repo.ensureCartId(userId);
    const items = await this.repo.findItems(cartId);
    return items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
  }
}
