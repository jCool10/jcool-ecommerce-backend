import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { STOCK_ADMIN, type StockAdminPort, type StockView } from './ports/stock-admin.port';

/**
 * `setOnHand` creates the row it cannot find ("this SKU now has 40 units" stands on its own), while
 * `adjust` 404s: "add 40" against an uninitialised SKU would invent a starting point nobody set.
 * Neither checks the variant against Catalog — Inventory holds no FK to `product_variants` by
 * design, and asking across would be the cross-context read that boundary exists to prevent.
 */
@Injectable()
export class AdjustStockUseCase {
  constructor(@Inject(STOCK_ADMIN) private readonly stock: StockAdminPort) {}

  async getLevel(variantId: string): Promise<StockView> {
    const level = await this.stock.getLevel(variantId);
    if (level === null) {
      throw new NotFoundException(`No stock level for variant: ${variantId}`);
    }
    return level;
  }

  setOnHand(variantId: string, quantity: number): Promise<StockView> {
    return this.stock.setOnHand(variantId, quantity);
  }

  async adjust(variantId: string, delta: number): Promise<StockView> {
    const level = await this.stock.adjust(variantId, delta);
    if (level === null) {
      throw new NotFoundException(`No stock level for variant: ${variantId}`);
    }
    return level;
  }
}
