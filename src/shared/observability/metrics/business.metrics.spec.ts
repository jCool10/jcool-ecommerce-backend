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
  const publishInc = vi.fn();
  const consumeInc = vi.fn();
  const retryInc = vi.fn();
  const dlqInc = vi.fn();
  const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const logger = { warn } as unknown as PinoLogger;
  const metrics = new BusinessMetrics(
    { inc: ordersInc } as unknown as Counter<string>,
    { observe: valueObserve } as unknown as Histogram<string>,
    { inc: cartInc } as unknown as Counter<string>,
    { inc: authInc } as unknown as Counter<string>,
    { inc: cacheInc } as unknown as Counter<string>,
    { inc: publishInc } as unknown as Counter<string>,
    { inc: consumeInc } as unknown as Counter<string>,
    { inc: retryInc } as unknown as Counter<string>,
    { inc: dlqInc } as unknown as Counter<string>,
    logger,
  );
  return {
    metrics,
    ordersInc,
    valueObserve,
    cartInc,
    authInc,
    cacheInc,
    publishInc,
    consumeInc,
    retryInc,
    dlqInc,
    warn,
  };
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

  it('counts a published event by type and result', () => {
    const { metrics, publishInc } = build();
    metrics.recordEventPublished('order.placed', 'refused');
    expect(publishInc).toHaveBeenCalledWith({ event_type: 'order.placed', result: 'refused' });
  });

  it('counts a consumed event by type and result', () => {
    const { metrics, consumeInc } = build();
    metrics.recordEventConsumed('order.placed', 'duplicate');
    expect(consumeInc).toHaveBeenCalledWith({ event_type: 'order.placed', result: 'duplicate' });
  });

  it('counts a retry by type only — the reason belongs to the dead letter, not to every attempt', () => {
    const { metrics, retryInc } = build();
    metrics.recordConsumeRetry('order.paid');
    expect(retryInc).toHaveBeenCalledWith({ event_type: 'order.paid' });
  });

  it('counts a dead letter by type and reason', () => {
    const { metrics, dlqInc } = build();
    metrics.recordDeadLetter('order.paid', 'permanent');
    expect(dlqInc).toHaveBeenCalledWith({ event_type: 'order.paid', reason: 'permanent' });
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
