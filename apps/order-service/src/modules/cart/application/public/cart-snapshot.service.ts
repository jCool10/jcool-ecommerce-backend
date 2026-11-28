import { Inject, Injectable } from '@nestjs/common';
import { CART_REPOSITORY, type CartRepositoryPort } from '../ports/cart-repository.port';
import type { CartSnapshotLine, CartSnapshotReader } from './cart-snapshot.port';

@Injectable()
export class CartSnapshotService implements CartSnapshotReader {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly cartRepo: CartRepositoryPort,
  ) {}

  async getLines(userId: string): Promise<CartSnapshotLine[]> {
    const cartId = await this.cartRepo.findCartId(userId);
    if (!cartId) return [];
    const items = await this.cartRepo.findItems(cartId);
    return items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
  }
}
