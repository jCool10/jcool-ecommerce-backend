import type { PinoLogger } from 'nestjs-pino';
import type { Counter, Histogram } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { BusinessMetrics } from './business.metrics';

// prom-client fakes: spy inc()/observe() and assert the label shapes (bounded values only).
function build() {
  const ordersInc = vi.fn();
  const valueObserve = vi.fn();
  const cartInc = vi.fn();
  const authInc = vi.fn();
  const cacheInc = vi.fn();
  const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const logger = { warn } as unknown as PinoLogger;
  const metrics = new BusinessMetrics(
    { inc: ordersInc } as unknown as Counter<string>,
    { observe: valueObserve } as unknown as Histogram<string>,
    { inc: cartInc } as unknown as Counter<string>,
    { inc: authInc } as unknown as Counter<string>,
    { inc: cacheInc } as unknown as Counter<string>,
    logger,
  );
  return { metrics, ordersInc, valueObserve, cartInc, authInc, cacheInc, warn };
}

describe('BusinessMetrics', () => {
  it('counts a placed order by its status label', () => {
    const { metrics, ordersInc } = build();
    metrics.recordOrderCreated('PENDING');
    expect(ordersInc).toHaveBeenCalledWith({ status: 'PENDING' });
  });

  it('observes the order value in minor units', () => {
    const { metrics, valueObserve } = build();
    metrics.observeOrderValue(125_000);
    expect(valueObserve).toHaveBeenCalledWith(125_000);
  });

  it('counts a cart operation by op', () => {
    const { metrics, cartInc } = build();
    metrics.recordCartOperation('add');
    expect(cartInc).toHaveBeenCalledWith({ op: 'add' });
  });

  it('counts an auth event by event + outcome', () => {
    const { metrics, authInc } = build();
    metrics.recordAuthEvent('login.failed', 'failure');
    expect(authInc).toHaveBeenCalledWith({ event: 'login.failed', outcome: 'failure' });
  });

  it('counts a catalog cache lookup by result', () => {
    const { metrics, cacheInc } = build();
    metrics.recordCatalogCacheOperation('hit');
    expect(cacheInc).toHaveBeenCalledWith({ result: 'hit' });
  });

  it('swallows a metric error and logs it — telemetry never breaks the business flow', () => {
    const { metrics, ordersInc, warn } = build();
    ordersInc.mockImplementation(() => {
      throw new Error('registry exploded');
    });

    expect(() => metrics.recordOrderCreated('PENDING')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
