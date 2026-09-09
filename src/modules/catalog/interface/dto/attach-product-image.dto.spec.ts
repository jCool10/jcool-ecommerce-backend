import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AttachProductImageDto } from './attach-product-image.dto';

const ASSET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(AttachProductImageDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('AttachProductImageDto', () => {
  it('accepts the highest display slot', () => {
    expect(failedProperties({ assetId: ASSET_ID, position: 10_000 })).toEqual([]);
  });

  // The next attach without a position derives `max(position) + 1`, so the accepted ceiling has to
  // stay far enough below int4 that deriving from it cannot overflow the column.
  it('rejects a slot above the display ceiling, well before int4 could overflow', () => {
    for (const position of [10_001, 2_147_483_647, 3_000_000_000]) {
      expect(failedProperties({ assetId: ASSET_ID, position })).toEqual(['position']);
    }
  });
});
