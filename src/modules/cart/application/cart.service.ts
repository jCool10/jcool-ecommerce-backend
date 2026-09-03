import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Money } from '@shared/kernel';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { Cart } from '../domain/cart.entity';
import { CART_REPOSITORY, type CartRepositoryPort } from './ports/cart-repository.port';
import { CATALOG_QUERY, type CartSkuView, type CatalogQueryPort } from './ports/catalog-query.port';

// Fallback when the cart has no priced lines to infer a currency from.
const DEFAULT_CURRENCY = 'VND';

/** One cart line with its live (not frozen) Catalog price resolved at read time. */
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
 * Cart write + read orchestration. One service (mirrors CatalogAdminService)
 * since every operation shares "ensure the user's cart exists, then return the
 * rebuilt view". Catalog is read only through `CATALOG_QUERY` (a port), never
 * its repository — the bounded-context boundary. Cart never freezes a price:
 * every view resolves the current Catalog price, so a Catalog price change is
 * reflected on the next read.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repo: CartRepositoryPort,
    @Inject(CATALOG_QUERY)
    private readonly catalog: CatalogQueryPort,
    @Inject(METRICS)
    private readonly metrics: MetricsPort,
  ) {}

  async view(userId: string): Promise<CartView> {
    const cartId = await this.repo.ensureCartId(userId);
    return this.buildView(cartId);
  }

  /** Add `quantity` of a SKU; a repeat SKU accumulates. Unknown SKU → 404. */
  async addItem(userId: string, skuId: string, quantity: number): Promise<CartView> {
    const sku = await this.catalog.getSkuView(skuId);
    if (!sku) {
      throw new NotFoundException(`SKU not found: ${skuId}`);
    }
    const cartId = await this.repo.ensureCartId(userId);
    await this.repo.addItem(cartId, skuId, quantity);
    this.metrics.recordCartOperation('add');
    return this.buildView(cartId);
  }

  /** Set a line's absolute quantity; the SKU must already be in the cart (else 404). */
  async setItemQuantity(userId: string, skuId: string, quantity: number): Promise<CartView> {
    const cartId = await this.repo.ensureCartId(userId);
    const updated = await this.repo.setItemQuantity(cartId, skuId, quantity);
    if (!updated) {
      throw new NotFoundException(`Cart item not found: ${skuId}`);
    }
    this.metrics.recordCartOperation('update');
    return this.buildView(cartId);
  }

  /** Remove one line (idempotent — removing an absent SKU is a no-op, still 200). */
  async removeItem(userId: string, skuId: string): Promise<CartView> {
    const cartId = await this.repo.ensureCartId(userId);
    await this.repo.removeItem(cartId, skuId);
    this.metrics.recordCartOperation('remove');
    return this.buildView(cartId);
  }

  async clear(userId: string): Promise<CartView> {
    const cartId = await this.repo.ensureCartId(userId);
    await this.repo.clear(cartId);
    this.metrics.recordCartOperation('clear');
    return this.buildView(cartId);
  }

  // Load lines, resolve the whole cart's SKU views from Catalog in one read, then assemble the
  // DTO lines here (presentation data) while the domain computes the money subtotal.
  private async buildView(cartId: string): Promise<CartView> {
    const items = await this.repo.findItems(cartId);
    const views = await this.catalog.getSkuViews(items.map((item) => item.skuId));
    const viewBySku = new Map<string, CartSkuView>(views.map((view) => [view.skuId, view]));

    // Cart currency = the first priced line's currency, walked in cart order rather than in the
    // batch read's order, which would anchor a mixed-currency cart on a different line. Uppercased
    // to match Money's normalized code, so the domain's same-currency subtotal guard never drops a
    // line over a mere case mismatch.
    const currency = (
      items.map((item) => viewBySku.get(item.skuId)).find((v) => v?.unitPriceMinor != null)?.currency ??
      DEFAULT_CURRENCY
    ).toUpperCase();

    const priceOf = (skuId: string): Money | null => {
      const v = viewBySku.get(skuId);
      return v && v.unitPriceMinor != null ? Money.of(v.unitPriceMinor, v.currency) : null;
    };
    const subtotal = new Cart(items).subtotal(currency, priceOf);

    const lines: CartLineView[] = items.map((item) => {
      const v = viewBySku.get(item.skuId);
      const unitPriceMinor = v?.unitPriceMinor ?? null;
      return {
        skuId: item.skuId,
        productName: v?.productName ?? '',
        quantity: item.quantity,
        unitPriceMinor,
        lineTotalMinor: unitPriceMinor != null ? unitPriceMinor * item.quantity : null,
        isActive: v?.isActive ?? false,
      };
    });

    return { items: lines, subtotalMinor: subtotal.amountMinor, currency };
  }
}
