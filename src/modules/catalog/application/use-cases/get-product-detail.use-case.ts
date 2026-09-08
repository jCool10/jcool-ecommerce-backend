import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Product } from '../../domain/entities';
import { MEDIA_QUERY, PRODUCT_REPOSITORY, type MediaQueryPort, type ProductRepositoryPort } from '../ports';

export interface ProductDetailResult {
  product: Product;
  /** assetId → URL, for the ids on `product.imageAssetIds`. */
  imageUrls: Map<string, string>;
}

// Fetch one ACTIVE product by id or slug; absent (or non-ACTIVE) → 404.
@Injectable()
export class GetProductDetailUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
    @Inject(MEDIA_QUERY)
    private readonly media: MediaQueryPort,
  ) {}

  async execute(idOrSlug: string): Promise<ProductDetailResult> {
    const product = await this.products.findActiveByIdOrSlug(idOrSlug);
    if (!product) {
      throw new NotFoundException(`Product not found: ${idOrSlug}`);
    }
    // After the repository read, which is where the cache sits — a signed URL must never enter it.
    return { product, imageUrls: await this.media.resolveUrls(product.imageAssetIds) };
  }
}
