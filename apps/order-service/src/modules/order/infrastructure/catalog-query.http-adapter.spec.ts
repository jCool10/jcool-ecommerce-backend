import type { Mock } from 'vitest';
import type { OutboundCall } from '@jcool/platform/resilience';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { OrderSkuView } from '../application/ports/catalog-query.port';
import { CheckoutReadUnavailableError } from '../application/checkout-unavailable.error';
import { ApiInternalClient } from './api-internal.http-client';
import { CatalogQueryHttpAdapter } from './catalog-query.http-adapter';
import { type ApiReply, FakeApiService, type ReceivedRequest, inRequest } from './testing/fake-api-service';

const TOKEN = 'order-to-api-token-order-to-api-token-000';
const skuId = (n: number) => String(137465797020397179n + BigInt(n));
const viewOf = (id: string): OrderSkuView => ({
  skuId: id,
  productName: `Product ${id}`,
  unitPriceMinor: 125_000,
  currency: 'VND',
  isActive: true,
});
const idsOf = (request: ReceivedRequest) => (request.body as { skuIds: string[] }).skuIds;
const answerEvery = (request: ReceivedRequest): ApiReply => ({
  status: 200,
  body: { views: idsOf(request).map(viewOf) },
});

const passThrough: OutboundCall = { run: (task) => task() };

describe('CatalogQueryHttpAdapter', () => {
  let api: FakeApiService;
  let error: Mock;
  let adapter: CatalogQueryHttpAdapter;

  beforeEach(async () => {
    error = vi.fn();
    api = new FakeApiService();
    const url = await api.start();
    adapter = new CatalogQueryHttpAdapter(
      new ApiInternalClient(
        { url, token: TOKEN, timeoutMs: 1_000 },
        passThrough,
        inRequest(),
        fakePinoLogger({ error }),
      ),
    );
  });

  afterEach(() => api.stop());

  it('posts the ids with the caller token and the request id', async () => {
    api.reply = answerEvery;

    await expect(adapter.getSkuViews([skuId(1), skuId(2)])).resolves.toEqual([viewOf(skuId(1)), viewOf(skuId(2))]);

    const [request] = api.received;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/internal/v1/catalog/sku-views');
    expect(request.body).toEqual({ skuIds: [skuId(1), skuId(2)] });
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers['x-request-id']).toBe('req-uuid');
  });

  it('reads a SKU with no price as one, and an inactive one as inactive', async () => {
    const unpriced = { ...viewOf(skuId(1)), unitPriceMinor: null };
    const archived = { ...viewOf(skuId(2)), isActive: false };
    api.reply = () => ({ status: 200, body: { views: [unpriced, archived] } });

    await expect(adapter.getSkuViews([skuId(1), skuId(2)])).resolves.toEqual([unpriced, archived]);
  });

  it('leaves out an id the catalog does not know, and keeps only the contract fields', async () => {
    api.reply = () => ({ status: 200, body: { views: [{ ...viewOf(skuId(2)), stock: 4 }] } });

    await expect(adapter.getSkuViews([skuId(1), skuId(2)])).resolves.toStrictEqual([viewOf(skuId(2))]);
  });

  it('answers no ids without calling the api, which refuses an empty batch', async () => {
    await expect(adapter.getSkuViews([])).resolves.toEqual([]);
    expect(api.received).toHaveLength(0);
  });

  it('asks for a repeated id once', async () => {
    api.reply = answerEvery;

    await expect(adapter.getSkuViews([skuId(1), skuId(1)])).resolves.toEqual([viewOf(skuId(1))]);
    expect(idsOf(api.received[0])).toEqual([skuId(1)]);
  });

  it('reads 250 ids as batches of 100, 100 and 50 and merges them by skuId', async () => {
    const ids = Array.from({ length: 250 }, (_, n) => skuId(n));
    // Each batch answered in reverse, so a merge by position would scramble the result.
    api.reply = (request) => ({ status: 200, body: { views: idsOf(request).map(viewOf).reverse() } });

    const views = await adapter.getSkuViews(ids);

    expect(api.received.map((request) => idsOf(request).length)).toEqual([100, 100, 50]);
    expect(api.received.flatMap(idsOf)).toEqual(ids);
    expect(new Map(views.map((view) => [view.skuId, view]))).toEqual(new Map(ids.map((id) => [id, viewOf(id)])));
  });

  // Sequential, so a failed batch also stops the ones after it.
  it.each([0, 1])('fails the whole read when batch %d fails', async (failing) => {
    const ids = Array.from({ length: 250 }, (_, n) => skuId(n));
    api.reply = (request) => (api.received.indexOf(request) === failing ? { status: 503 } : answerEvery(request));

    await expect(adapter.getSkuViews(ids)).rejects.toBeInstanceOf(CheckoutReadUnavailableError);
    expect(api.received).toHaveLength(failing + 1);
  });

  it.each<[string, ApiReply]>([
    ['a 400', { status: 400 }],
    ['a negative price', { status: 200, body: { views: [{ ...viewOf(skuId(1)), unitPriceMinor: -1 }] } }],
    ['a view with no currency', { status: 200, body: { views: [{ ...viewOf(skuId(1)), currency: undefined }] } }],
    ['no views field', { status: 200, body: [viewOf(skuId(1))] }],
  ])('fails the read on %s and logs it', async (_case, reply) => {
    api.reply = () => reply;

    await expect(adapter.getSkuViews([skuId(1)])).rejects.toBeInstanceOf(CheckoutReadUnavailableError);
    expect(error).toHaveBeenCalledOnce();
  });
});
