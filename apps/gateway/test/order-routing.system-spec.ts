import { Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayImage, hits, PUBLIC_PORT, startFixture, startGateway, urlOf } from './gateway-stack';

interface Echo {
  upstream: string;
  method: string;
  url: string;
}

const UPSTREAMS = {
  API_UPSTREAM: 'api:3000',
  INVENTORY_UPSTREAM: 'inventory:3000',
  PAYMENT_UPSTREAM: 'payment:3000',
  ORDER_UPSTREAM: 'order:3000',
};

// Checkout left the api; everything else under /orders and /admin/orders follows it.
describe('gateway: order routes', () => {
  let network: StartedNetwork;
  let api: StartedTestContainer;
  let order: StartedTestContainer;
  let fixtures: StartedTestContainer[] = [];
  let gateway: StartedTestContainer;

  beforeAll(async () => {
    await buildGatewayImage();
    network = await new Network().start();
    fixtures = await Promise.all(
      ['api', 'order', 'inventory', 'payment'].map((name) =>
        startFixture(network, 'fake-upstream.cjs', name, { NAME: name }),
      ),
    );
    [api, order] = fixtures;
    gateway = await startGateway(network, UPSTREAMS);
  });

  afterAll(async () => {
    await Promise.allSettled([gateway, ...fixtures].map((container) => container?.stop()));
    await network?.stop();
  });

  const send = (target: StartedTestContainer, path: string, method = 'GET') =>
    fetch(urlOf(target, PUBLIC_PORT, path), { method });
  const upstreamOf = async (path: string, method = 'GET', target = gateway) =>
    ((await (await send(target, path, method)).json()) as Echo).upstream;

  it('sends the order routes to the order-service, and nothing else', async () => {
    for (const [path, method] of [
      ['/orders', 'GET'],
      ['/orders', 'POST'],
      ['/orders/1', 'GET'],
      ['/orders/1/pay', 'POST'],
      ['/orders/1/cancel', 'POST'],
      ['/admin/orders', 'GET'],
      ['/admin/orders/1/cancel', 'POST'],
    ]) {
      expect(await upstreamOf(path, method), `${method} ${path}`).toBe('order');
    }
    for (const path of ['/products', '/cart', '/ordersx', '/admin/ordersx', '/admin/products']) {
      expect(await upstreamOf(path), path).toBe('api');
    }
  });

  it("keeps the api's internal read routes off the public listener", async () => {
    const before = await Promise.all([hits(api), hits(order)]);

    expect((await send(gateway, '/internal/v1/carts/1/lines')).status).toBe(404);
    expect((await send(gateway, '/internal/v1/catalog/sku-views', 'POST')).status).toBe(404);
    expect(await Promise.all([hits(api), hits(order)])).toEqual(before);
  });

  // The gateway's own healthcheck, so a freeze flip never waits on the order-service or Temporal.
  it('hands /health/ready to the api, never the order-service', async () => {
    const before = await hits(order);

    expect(await upstreamOf('/health/ready')).toBe('api');
    expect(await hits(order)).toBe(before);
  });

  describe('checkout frozen for the cutover', () => {
    let frozen: StartedTestContainer;

    beforeAll(async () => {
      frozen = await startGateway(network, { ...UPSTREAMS, CHECKOUT_WRITE_FREEZE: 'true' });
    });

    afterAll(async () => {
      await frozen?.stop();
    });

    // The freeze has to sit above the order route: a request only ever enters one handle.
    it('turns every POST under /orders away before it reaches the order-service', async () => {
      const before = await hits(order);

      for (const path of ['/orders', '/orders/', '/orders/1/pay', '/orders/1/pay/']) {
        const res = await send(frozen, path, 'POST');
        expect(res.status, path).toBe(503);
        expect(res.headers.get('retry-after'), path).toBe('120');
      }
      expect(await hits(order)).toBe(before);
    });

    it('still serves order reads and the admin cancel that shortens the drain', async () => {
      expect(await upstreamOf('/orders', 'GET', frozen)).toBe('order');
      expect(await upstreamOf('/admin/orders/1/cancel', 'POST', frozen)).toBe('order');
    });
  });
});
