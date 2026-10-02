import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetPriceDto } from './set-price.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(SetPriceDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('SetPriceDto', () => {
  it('accepts an amount up to the int4 ceiling and refuses one beyond it', () => {
    expect([2_147_483_647, 2_147_483_648].map((amountMinor) => failedProperties({ amountMinor }))).toEqual([
      [],
      ['amountMinor'],
    ]);
  });
});
