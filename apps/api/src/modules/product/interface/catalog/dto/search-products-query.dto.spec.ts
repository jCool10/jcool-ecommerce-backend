import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SearchProductsQueryDto } from './search-products-query.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(SearchProductsQueryDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('SearchProductsQueryDto', () => {
  it('accepts a well-formed query', () => {
    expect(failedProperties({ q: 'headphones', page: '2', pageSize: '50', categorySlug: 'audio' })).toEqual([]);
  });

  it('rejects each out-of-bounds field on its own name', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'q'],
      [{ q: '   ' }, 'q'],
      [{ q: 'x'.repeat(101) }, 'q'],
      [{ q: 'a', pageSize: '101' }, 'pageSize'],
      [{ q: 'a', pageSize: '0' }, 'pageSize'],
      [{ q: 'a', page: '0' }, 'page'],
      [{ q: 'a', page: '10001' }, 'page'],
      [{ q: 'a', categorySlug: 'Audio Gear' }, 'categorySlug'],
    ];

    expect(cases.map(([raw]) => failedProperties(raw))).toEqual(cases.map(([, property]) => [property]));
  });
});
