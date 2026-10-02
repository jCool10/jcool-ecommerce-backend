import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Product } from '../../../domain/catalog/entities';
import { MEDIA_QUERY, PRODUCT_REPOSITORY, type MediaQueryPort, type ProductRepositoryPort } from '../ports';

export interface ProductDetailResult {
  product: Product;
  /** assetId → URL. */
  imageUrls: Map<string, string>;
}

@Injectable()
export class GetProductDetailUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepo: ProductRepositoryPort,
    @Inject(MEDIA_QUERY)
    private readonly mediaQuery: MediaQueryPort,
  ) {}

  async execute(idOrSlug: string): Promise<ProductDetailResult> {
    const product = await this.productRepo.findActiveByIdOrSlug(idOrSlug);
    if (!product) {
      throw new NotFoundException(`Product not found: ${idOrSlug}`);
    }
    // After the repository read, which is where the cache sits — a signed URL must never enter it.
    return { product, imageUrls: await this.mediaQuery.resolveUrls(product.imageAssetIds) };
  }
}
