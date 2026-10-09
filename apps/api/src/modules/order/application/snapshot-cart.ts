import { BadRequestException } from '@nestjs/common';
import { OrderItem } from '../domain/order-item.entity';
import type { CartSnapshotReaderPort } from './ports/cart-snapshot.port';
import type { CatalogQueryPort, OrderSkuView } from './ports/catalog-query.port';

/**
 * Prices the user's cart as one single-currency order. Each line's price is frozen here, so a later
 * Catalog price change never moves the total.
 */
export async function snapshotCart(
  cartSnapshotReader: CartSnapshotReaderPort,
  catalogQuery: CatalogQueryPort,
  userId: string,
): Promise<{ currency: string; items: OrderItem[] }> {
  const lines = await cartSnapshotReader.getLines(userId);
  if (lines.length === 0) {
    throw new BadRequestException('Cart is empty');
  }

  const views = await catalogQuery.getSkuViews(lines.map((line) => line.skuId));
  const viewBySku = new Map<string, OrderSkuView>(views.map((view) => [view.skuId, view]));
  // The order's currency is the first surviving line's, walked in cart order rather than in the
  // batch read's order, which would anchor on a different line and blame a different one below.
  const currency = lines.map((line) => viewBySku.get(line.skuId)).find((v) => v != null)?.currency;
  if (!currency) {
    throw new BadRequestException('Cart items no longer exist in catalog');
  }

  const items = lines.map((line) => {
    const skuView = viewBySku.get(line.skuId);
    if (!skuView) {
      throw new BadRequestException(`SKU no longer exists in catalog: ${line.skuId}`);
    }
    // Order is the sell/commit boundary: an archived product / archived variant is not orderable,
    // even if a residual price lingers.
    if (!skuView.isActive) {
      throw new BadRequestException(`SKU is not available for order: ${line.skuId}`);
    }
    if (skuView.unitPriceMinor == null) {
      throw new BadRequestException(`SKU is not purchasable (no price): ${line.skuId}`);
    }
    if (skuView.currency !== currency) {
      throw new BadRequestException('Cart mixes currencies; cannot create a single-currency order');
    }
    return OrderItem.of(line.skuId, skuView.productName, skuView.unitPriceMinor, line.quantity);
  });
  return { currency, items };
}
