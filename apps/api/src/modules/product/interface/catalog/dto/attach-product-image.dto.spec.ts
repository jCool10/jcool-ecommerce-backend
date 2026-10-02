import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { sampleId } from '@shared/testing/id-generator.double';
import { AttachProductImageDto } from './attach-product-image.dto';

const ASSET_ID = sampleId();

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
