import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetPriceDto } from './set-price.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(SetPriceDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('SetPriceDto', () => {
  it('accepts a price at the int4 ceiling the column can still store', () => {
    expect(failedProperties({ amountMinor: 2_147_483_647, currency: 'VND' })).toEqual([]);
  });

  // Without the cap this reaches Postgres as a 22003 the filter masks into a 500.
  it('rejects an amount the int4 price column cannot hold', () => {
    expect(failedProperties({ amountMinor: 3_000_000_000 })).toEqual(['amountMinor']);
  });
});
