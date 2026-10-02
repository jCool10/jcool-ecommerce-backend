import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Money } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { Cart } from '../domain/cart.entity';
import { CART_REPOSITORY, type CartRepositoryPort } from './ports/cart-repository.port';
import { CATALOG_QUERY, type CartSkuView, type CatalogQueryPort } from './ports/catalog-query.port';

const DEFAULT_CURRENCY = 'VND';

export interface CartLineView {
  skuId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  isActive: boolean;
}

export interface CartView {
  items: CartLineView[];
  subtotalMinor: number;
  currency: string;
}

/**
 * Catalog is read only through `CATALOG_QUERY`, never its repository — the bounded-context boundary.
 * Cart never freezes a price: every view resolves the current Catalog price, so a Catalog price
 * change is reflected on the next read.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly cartRepo: CartRepositoryPort,
    @Inject(CATALOG_QUERY)
    private readonly catalogQuery: CatalogQueryPort,
    @Inject(METRICS)
    private readonly metrics: MetricsPort,
  ) {}

  async view(userId: string): Promise<CartView> {
    return this.buildView(await this.cartRepo.findCartId(userId));
  }

  async addItem(userId: string, skuId: string, quantity: number): Promise<CartView> {
    const sku = await this.catalogQuery.getSkuView(skuId);
    if (!sku) {
      throw new NotFoundException(`SKU not found: ${skuId}`);
    }
    const cartId = await this.cartRepo.ensureCartId(userId);
    await this.cartRepo.addItem(cartId, skuId, quantity);
    this.metrics.recordCartOperation('add');
    return this.buildView(cartId);
  }

  async setItemQuantity(userId: string, skuId: string, quantity: number): Promise<CartView> {
    const cartId = await this.cartRepo.ensureCartId(userId);
    const updated = await this.cartRepo.setItemQuantity(cartId, skuId, quantity);
    if (!updated) {
      throw new NotFoundException(`Cart item not found: ${skuId}`);
    }
    this.metrics.recordCartOperation('update');
    return this.buildView(cartId);
  }

  async removeItem(userId: string, skuId: string): Promise<CartView> {
    const cartId = await this.cartRepo.ensureCartId(userId);
    await this.cartRepo.removeItem(cartId, skuId);
    this.metrics.recordCartOperation('remove');
    return this.buildView(cartId);
  }

  async clear(userId: string): Promise<CartView> {
    const cartId = await this.cartRepo.ensureCartId(userId);
    await this.cartRepo.clear(cartId);
    this.metrics.recordCartOperation('clear');
    return this.buildView(cartId);
  }

  private async buildView(cartId: string | null): Promise<CartView> {
    const items = cartId ? await this.cartRepo.findItems(cartId) : [];
    const views = await this.catalogQuery.getSkuViews(items.map((item) => item.skuId));
    const viewBySku = new Map<string, CartSkuView>(views.map((view) => [view.skuId, view]));

    // First priced line in CART order, not the batch read's order, which would anchor a
    // mixed-currency cart on a different line. Uppercased to match Money's normalized code so the
    // domain's same-currency subtotal guard never drops a line over a case mismatch.
    const currency = (
      items.map((item) => viewBySku.get(item.skuId)).find((v) => v?.unitPriceMinor != null)?.currency ??
      DEFAULT_CURRENCY
    ).toUpperCase();

    const priceOf = (skuId: string): Money | null => {
      const skuView = viewBySku.get(skuId);
      return skuView && skuView.unitPriceMinor != null ? Money.of(skuView.unitPriceMinor, skuView.currency) : null;
    };
    const subtotal = new Cart(items).subtotal(currency, priceOf);

    const lines: CartLineView[] = items.map((item) => {
      const skuView = viewBySku.get(item.skuId);
      const unitPriceMinor = skuView?.unitPriceMinor ?? null;
      return {
        skuId: item.skuId,
        productName: skuView?.productName ?? '',
        quantity: item.quantity,
        unitPriceMinor,
        lineTotalMinor: unitPriceMinor != null ? unitPriceMinor * item.quantity : null,
        isActive: skuView?.isActive ?? false,
      };
    });

    return { items: lines, subtotalMinor: subtotal.amountMinor, currency };
  }
}
