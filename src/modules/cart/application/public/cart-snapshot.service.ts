import { Inject, Injectable } from '@nestjs/common';
import { CART_REPOSITORY, type CartRepositoryPort } from '../ports/cart-repository.port';
import type { CartSnapshotLine, CartSnapshotReader } from './cart-snapshot.port';

/**
 * Implements Cart's published snapshot port over the cart repository. Thin by
 * design: the port is the stable cross-context contract, the repository is the
 * swap point. Reading is get-or-create (an absent cart yields an empty snapshot),
 * so a consumer never has to special-case "no cart yet".
 */
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
