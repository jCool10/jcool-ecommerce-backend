import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListProductsQueryDto } from './list-products-query.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(ListProductsQueryDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('ListProductsQueryDto', () => {
  it('bounds pageSize at 100 and q at 100 characters', () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ pageSize: '100', q: 'x'.repeat(100) }, []],
      [{ pageSize: '101' }, ['pageSize']],
      [{ pageSize: '0' }, ['pageSize']],
      [{ q: 'x'.repeat(101) }, ['q']],
    ];

    expect(cases.map(([raw]) => failedProperties(raw))).toEqual(cases.map(([, failed]) => failed));
  });
});
