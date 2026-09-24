import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AttachProductImageDto } from './attach-product-image.dto';

const ASSET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function failedProperties(raw: Record<string, unknown>): string[] {
  const dto = plainToInstance(AttachProductImageDto, raw, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);
}

describe('AttachProductImageDto', () => {
  it('caps the display slot at 10000', () => {
    expect([10_000, 10_001].map((position) => failedProperties({ assetId: ASSET_ID, position }))).toEqual([
      [],
      ['position'],
    ]);
  });
});
