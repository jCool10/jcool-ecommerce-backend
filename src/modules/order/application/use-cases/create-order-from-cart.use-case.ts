import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort, type OrderSkuView } from '../ports/catalog-query.port';
import { loadOrderView, type OrderView } from '../order-view.mapper';

/**
 * Snapshot the user's cart into a new DRAFT order. Raw lines come from Cart's
 * published port; price/name are resolved live from Catalog once, then frozen into
 * the order — from then on every read comes from the order's own rows, so a later
 * Catalog price change never alters a placed order (the transactional-truth
 * invariant). Cross-context reads go only through the two ports, never their repos.
 */
@Injectable()
export class CreateOrderFromCartUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(CART_SNAPSHOT_READER) private readonly cart: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalog: CatalogQueryPort,
  ) {}

  /** Empty/unpurchasable cart → 400. */
  async execute(userId: string): Promise<OrderView> {
    const lines = await this.cart.getLines(userId);
    if (lines.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // Resolve each SKU's live price/name once, then freeze it into the order.
    const views = await Promise.all(lines.map((line) => this.catalog.getSkuView(line.skuId)));
    const currency = views.find((v): v is OrderSkuView => v != null)?.currency;
    if (!currency) {
      throw new BadRequestException('Cart items no longer exist in catalog');
    }

    const items = lines.map((line, i) => {
      const v = views[i];
      if (!v) {
        throw new BadRequestException(`SKU no longer exists in catalog: ${line.skuId}`);
      }
      // Order is the sell/commit boundary: an archived product / archived variant is
      // not orderable, even if a residual price lingers.
      if (!v.isActive) {
        throw new BadRequestException(`SKU is not available for order: ${line.skuId}`);
      }
      if (v.unitPriceMinor == null) {
        throw new BadRequestException(`SKU is not purchasable (no price): ${line.skuId}`);
      }
      if (v.currency !== currency) {
        throw new BadRequestException('Cart mixes currencies; cannot create a single-currency order');
      }
      return OrderItem.of(line.skuId, v.productName, v.unitPriceMinor, line.quantity);
    });

    const orderId = await this.repo.create(Order.create(userId, currency, items));
    return loadOrderView(this.repo, orderId, userId);
  }
}
