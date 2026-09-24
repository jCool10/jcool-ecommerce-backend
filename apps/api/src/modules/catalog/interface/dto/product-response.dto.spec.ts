import { Product } from '../../domain/entities';
import { ProductResponseDto } from './product-response.dto';

describe('ProductResponseDto', () => {
  it('lists images in display order and drops one whose asset is gone', () => {
    const product = new Product('p1', 'P', 'p', null, 'ACTIVE', { slug: 'c', name: 'C' }, [], new Date(0), [
      'b',
      'gone',
      'a',
    ]);
    const urls = new Map([
      ['a', 'https://cdn/a'],
      ['b', 'https://cdn/b'],
    ]);

    expect(ProductResponseDto.fromEntity(product, urls).images).toEqual([
      { assetId: 'b', url: 'https://cdn/b' },
      { assetId: 'a', url: 'https://cdn/a' },
    ]);
  });
});
