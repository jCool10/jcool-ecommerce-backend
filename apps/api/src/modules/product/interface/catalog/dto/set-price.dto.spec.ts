import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetPriceDto } from './set-price.dto';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(SetPriceDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('SetPriceDto', () => {
  // A zero price would open a zero-amount payment, and the order-service refuses it in a SKU snapshot.
  it('refuses a zero or negative amount and accepts 1', () => {
    expect([0, -1, 1].map((amountMinor) => failedProperties({ amountMinor }))).toEqual([
      ['amountMinor'],
      ['amountMinor'],
      [],
    ]);
  });

  it('accepts an amount up to the int4 ceiling and refuses one beyond it', () => {
    expect([2_147_483_647, 2_147_483_648].map((amountMinor) => failedProperties({ amountMinor }))).toEqual([
      [],
      ['amountMinor'],
    ]);
  });
});
