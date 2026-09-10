import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SearchProductsQueryDto } from './search-products-query.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(SearchProductsQueryDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

// The categorySlug shape check is a security boundary, not tidiness: the value reaches the engine
// inside a filter expression, and this is the first of its two defences.
describe('SearchProductsQueryDto', () => {
  it('accepts a well-formed query', () => {
    expect(failedProperties({ q: 'headphones', page: '2', pageSize: '50', categorySlug: 'audio' })).toEqual([]);
  });

  it('defaults page and pageSize when the caller omits them', () => {
    const dto = plainToInstance(SearchProductsQueryDto, { q: 'headphones' });

    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });

  it('coerces the numeric params from their query-string form', () => {
    const dto = plainToInstance(SearchProductsQueryDto, { q: 'headphones', page: '3', pageSize: '40' });

    expect(dto.page).toBe(3);
    expect(dto.pageSize).toBe(40);
  });

  it.each([
    ['missing q', {}],
    ['empty q', { q: '' }],
    ['whitespace-only q', { q: '   ' }],
    ['q over the length cap', { q: 'x'.repeat(101) }],
    ['pageSize over the cap', { q: 'a', pageSize: '101' }],
    ['pageSize below one', { q: 'a', pageSize: '0' }],
    ['page below one', { q: 'a', page: '0' }],
    ['page over the cap', { q: 'a', page: '10001' }],
    ['categorySlug that is not a slug', { q: 'a', categorySlug: 'Audio Gear' }],
    ['categorySlug carrying filter syntax', { q: 'a', categorySlug: 'audio" OR status = "DRAFT' }],
  ])('rejects %s', (_label, raw) => {
    expect(failedProperties(raw)).not.toEqual([]);
  });
});
