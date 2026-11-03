import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AttachProductImageDto } from './attach-product-image.dto';
import { CreateCategoryDto } from './create-category.dto';
import { CreateProductDto } from './create-product.dto';
import { CreateSkuDto } from './create-sku.dto';
import { ListProductsQueryDto } from './list-products-query.dto';
import { SearchProductsQueryDto } from './search-products-query.dto';
import { UpdateProductDto } from './update-product.dto';
import { UpdateSkuDto } from './update-sku.dto';

const ID = '137465797020397179';

function failed<T extends object>(cls: new () => T, raw: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(cls, raw)).map((e) => e.property);
}

describe('free-text fields', () => {
  it('refuse a null byte', () => {
    expect(failed(ListProductsQueryDto, { q: '\0' })).toEqual(['q']);
    expect(failed(SearchProductsQueryDto, { q: 'a\0' })).toEqual(['q']);
    expect(failed(CreateCategoryDto, { name: 'a\0', slug: 'a' })).toEqual(['name']);
    expect(failed(CreateProductDto, { name: '\0', slug: 'ok', categoryId: ID })).toEqual(['name']);
    expect(failed(CreateProductDto, { name: 'ok', slug: 'ok', description: 'x\0', categoryId: ID })).toEqual([
      'description',
    ]);
    expect(failed(UpdateProductDto, { description: 'x\0' })).toEqual(['description']);
    expect(failed(CreateSkuDto, { sku: 'A\0', name: 'ok' })).toEqual(['sku']);
    expect(failed(UpdateSkuDto, { name: 'n\0' })).toEqual(['name']);
    expect(failed(AttachProductImageDto, { assetId: ID, alt: 'a\0' })).toEqual(['alt']);
  });

  it('accept clean text', () => {
    expect(failed(CreateSkuDto, { sku: 'WH-BLK', name: 'Wireless / Black' })).toEqual([]);
    expect(failed(ListProductsQueryDto, { q: 'headphones' })).toEqual([]);
  });
});
