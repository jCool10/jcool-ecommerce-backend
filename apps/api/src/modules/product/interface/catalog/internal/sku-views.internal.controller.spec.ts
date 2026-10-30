import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SKU_VIEW_BATCH } from '@jcool/internal-contracts';
import type { ProductSkuQuery, SkuView } from '../../../application/public/product-sku-query.port';
import { SkuViewsDto, SkuViewsInternalController } from './sku-views.internal.controller';

const SKU_ID = '137465797020397180';

// Same options as the global pipe in main.ts.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const isRefused = (body: unknown): Promise<boolean> =>
  pipe.transform(body, { type: 'body', metatype: SkuViewsDto }).then(
    () => false,
    (error: unknown) => error instanceof BadRequestException,
  );

const ids = (n: number) => Array.from({ length: n }, () => SKU_ID);

describe('SkuViewsInternalController validation', () => {
  it(`takes 1 to ${MAX_SKU_VIEW_BATCH} SKU ids`, async () => {
    const answers = await Promise.all([ids(1), ids(MAX_SKU_VIEW_BATCH)].map((skuIds) => isRefused({ skuIds })));

    expect(answers).toEqual([false, false]);
  });

  it.each([
    ['no ids', { skuIds: [] }],
    ['one id past the batch cap', { skuIds: ids(MAX_SKU_VIEW_BATCH + 1) }],
    ['an id that is not routable', { skuIds: [SKU_ID, 'sku-1'] }],
    ['ids that are not a list', { skuIds: SKU_ID }],
    ['no skuIds at all', {}],
    ['an unknown field', { skuIds: [SKU_ID], currency: 'VND' }],
  ])('refuses %s', async (_case, body) => {
    expect(await isRefused(body)).toBe(true);
  });
});

describe('SkuViewsInternalController answers', () => {
  it('passes the batch through in one read and answers only the contract fields', async () => {
    const view = {
      skuId: SKU_ID,
      productName: 'Mug',
      unitPriceMinor: null,
      currency: 'VND',
      isActive: true,
      productStatus: 'ACTIVE',
    } as SkuView;
    const catalog = {
      getSkuView: vi.fn(),
      getSkuViews: vi.fn<ProductSkuQuery['getSkuViews']>().mockResolvedValue([view]),
    };

    const answer = await new SkuViewsInternalController(catalog).views({ skuIds: [SKU_ID] });

    expect(catalog.getSkuViews).toHaveBeenCalledOnce();
    expect(catalog.getSkuViews).toHaveBeenCalledWith([SKU_ID]);
    expect(answer).toStrictEqual({
      views: [{ skuId: SKU_ID, productName: 'Mug', unitPriceMinor: null, currency: 'VND', isActive: true }],
    });
  });
});
