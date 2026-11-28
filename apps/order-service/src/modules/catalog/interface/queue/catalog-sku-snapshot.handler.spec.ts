import { describe, expect, it, vi } from 'vitest';
import { CATALOG_SKU_SNAPSHOT_EVENT } from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import type { DrizzleTx } from '../../../../database';
import { sampleId } from '../../../../shared/testing/id-generator.double';
import type { CatalogSkuViewWriterPort } from '../../application/ports/catalog-sku-view-writer.port';
import { CatalogSkuSnapshotHandler } from './catalog-sku-snapshot.handler';

const PRODUCT_ID = sampleId(1);
const PRODUCT_NAME = 'Linen shirt';
const tx = Symbol('tx') as unknown as DrizzleTx;

const PAYLOAD = {
  productId: PRODUCT_ID,
  version: 4,
  productName: PRODUCT_NAME,
  skus: [
    { skuId: sampleId(2), unitPriceMinor: 249_000, currency: 'VND', isActive: true },
    { skuId: sampleId(3), unitPriceMinor: null, currency: 'VND', isActive: false },
  ],
};

function job(payload: Record<string, unknown>, aggregateId = PRODUCT_ID): DomainEventJob {
  return {
    outboxId: sampleId(9),
    aggregateType: 'Product',
    aggregateId,
    eventType: CATALOG_SKU_SNAPSHOT_EVENT,
    payload,
    occurredAt: '2026-11-12T08:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const applySnapshot = vi.fn<CatalogSkuViewWriterPort['applySnapshot']>().mockResolvedValue(undefined);
  return { handler: new CatalogSkuSnapshotHandler({ applySnapshot }), applySnapshot };
}

describe('CatalogSkuSnapshotHandler', () => {
  it('applies the snapshot only once the step runs inside the transaction', async () => {
    const { handler, applySnapshot } = build();

    const step = await handler.prepare(job(PAYLOAD));
    expect(applySnapshot).not.toHaveBeenCalled();

    await expect(step(tx)).resolves.toBeUndefined();
    expect(applySnapshot).toHaveBeenCalledExactlyOnceWith(tx, PAYLOAD);
  });

  // Identical on every redelivery, so a retry could only fail the same way: straight to the DLQ.
  it.each([
    ['another currency', { skus: [{ ...PAYLOAD.skus[0], currency: 'USD' }] }, 'skus[0].currency'],
    ['a zero price', { skus: [{ ...PAYLOAD.skus[0], unitPriceMinor: 0 }] }, 'skus[0].unitPriceMinor'],
    ['a version past the ceiling', { version: 2_147_483_648 }, 'version'],
    ['no product name', { productName: undefined }, 'productName'],
    ['a productId that is not routable', { productId: 'product-1' }, 'productId is not a routable id'],
    [
      'a skuId that is not routable',
      { skus: [PAYLOAD.skus[0], { ...PAYLOAD.skus[1], skuId: '42' }] },
      'skus[1].skuId is not a routable id',
    ],
  ])('dead-letters a snapshot with %s, naming the bound', async (_case, override, bound) => {
    const { handler, applySnapshot } = build();
    const broken = { ...PAYLOAD, ...override };

    const refusal = handler.prepare(job(broken, (broken as { productId?: string }).productId));

    await expect(refusal).rejects.toBeInstanceOf(PermanentError);
    await expect(refusal).rejects.toThrow(bound);
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('dead-letters a snapshot filed under another product', async () => {
    const { handler, applySnapshot } = build();

    const refusal = handler.prepare(job(PAYLOAD, sampleId(5)));

    await expect(refusal).rejects.toBeInstanceOf(PermanentError);
    await expect(refusal).rejects.toThrow('aggregateId is not the payload productId');
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('names the message but never quotes the product name', async () => {
    const { handler } = build();

    const error = await handler.prepare(job({ ...PAYLOAD, version: -1 })).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(sampleId(9));
    expect((error as Error).message).not.toContain(PRODUCT_NAME);
  });
});
