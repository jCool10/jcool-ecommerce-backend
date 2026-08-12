import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Product } from '../../domain/entities/product.entity';
import { PRODUCT_REPOSITORY, type ProductRepositoryPort } from '../ports/product-repository.port';

// Fetch one ACTIVE product by id or slug; absent (or non-ACTIVE) → 404.
@Injectable()
export class GetProductDetailUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
  ) {}

  async execute(idOrSlug: string): Promise<Product> {
    const product = await this.products.findActiveByIdOrSlug(idOrSlug);
    if (!product) {
      throw new NotFoundException(`Product not found: ${idOrSlug}`);
    }
    return product;
  }
}
