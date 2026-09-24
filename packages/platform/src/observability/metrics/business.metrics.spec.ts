import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { Registry, register, type Counter } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { BreakerState } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { BusinessMetrics } from './business.metrics';
import { BUSINESS_METRIC_PROVIDERS, CIRCUIT_BREAKER_STATE, ORDERS_CREATED_TOTAL } from './metric-definitions';

async function build() {
  const warn = vi.fn();
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...BUSINESS_METRIC_PROVIDERS,
      BusinessMetrics,
      { provide: PinoLogger, useValue: fakePinoLogger({ warn }) },
    ],
  }).compile();
  // The providers always create into prom-client's global registry; move them into one this test owns.
  const registry = new Registry();
  for (const { name } of register.getMetricsAsArray()) registry.registerMetric(register.getSingleMetric(name)!);
  register.clear();
  return { metrics: moduleRef.get(BusinessMetrics), registry, warn };
}

describe('BusinessMetrics', () => {
  // prom-client throws on a label its definition does not declare, and `safely()` turns that into a
  // warn, so drift between a call site and metric-definitions.ts would otherwise lose the series.
  it('records every series under the labels its definition declares', async () => {
    const { metrics, registry, warn } = await build();

    metrics.recordOrderCreated('PENDING');
    metrics.observeOrderValue(125_000);
    metrics.recordCartOperation('add');
    metrics.recordAuthEvent('login.failed', 'failure');
    metrics.recordCatalogCacheOperation('hit_fresh');
    metrics.recordEventPublished('order.placed', 'refused');
    metrics.recordEventConsumed('order.placed', 'duplicate');
    metrics.recordConsumeRetry('order.paid');
    metrics.recordDeadLetter('order.paid', 'permanent');
    metrics.recordSagaStep('payment_session', 'failed');
    metrics.recordCompensation('ttl_expired');
    metrics.recordReservationExpiry();
    metrics.recordRefundOwed('webhook_direct');
    metrics.recordMailSendFailure('order_paid');
    metrics.recordRetentionSweep('messaging:outbox', 0);
    metrics.observeRetentionSweepDuration('messaging:outbox', 0.2);
    metrics.recordRetentionSweepFailure('messaging:outbox');
    metrics.recordMediaBytesReclaimed(2048);
    metrics.observeCacheRebuild(0.042);
    metrics.setBreakerState('payment_gateway', 'open');
    metrics.recordBreakerTransition('payment_gateway', 'open');
    metrics.recordBreakerCall('payment_gateway', 'rejected');
    metrics.recordRateLimitRejection('account', '/auth/login');
    metrics.recordSessionEpochLookup('miss');

    const exposition = await registry.metrics();
    const expected = [
      'orders_created_total{status="PENDING"} 1',
      'order_value_minor_sum 125000',
      'cart_operations_total{op="add"} 1',
      'auth_events_total{event="login.failed",outcome="failure"} 1',
      'catalog_cache_operations_total{result="hit_fresh"} 1',
      'messaging_publish_total{event_type="order.placed",result="refused"} 1',
      'messaging_consume_total{event_type="order.placed",result="duplicate"} 1',
      'messaging_consume_retries_total{event_type="order.paid"} 1',
      'messaging_dlq_total{event_type="order.paid",reason="permanent"} 1',
      'saga_step_total{step="payment_session",outcome="failed"} 1',
      'saga_compensation_total{trigger="ttl_expired"} 1',
      'reservation_expiry_total 1',
      'payment_refund_owed_total{source="webhook_direct"} 1',
      'mail_send_failures_total{kind="order_paid"} 1',
      // Recorded at zero so an idle sweep still has a series to alert on.
      'retention_rows_deleted_total{sweep="messaging:outbox"} 0',
      'retention_sweep_duration_seconds_count{sweep="messaging:outbox"} 1',
      'retention_sweep_failures_total{sweep="messaging:outbox"} 1',
      'media_bytes_reclaimed_total 2048',
      'cache_rebuild_duration_seconds_count 1',
      'circuit_breaker_state{breaker="payment_gateway"} 2',
      'circuit_breaker_transitions_total{breaker="payment_gateway",to="open"} 1',
      'circuit_breaker_calls_total{breaker="payment_gateway",result="rejected"} 1',
      'rate_limit_rejections_total{tier="account",route="/auth/login"} 1',
      'session_epoch_lookups_total{result="miss"} 1',
    ];

    expect(warn).not.toHaveBeenCalled();
    expect(expected.filter((line) => !exposition.includes(line))).toEqual([]);
  });

  // resilience.yml fires on `circuit_breaker_state >= 1` and `>= 2`.
  it('orders breaker states on the gauge as closed 0, half_open 1, open 2', async () => {
    const { metrics, registry } = await build();
    const gauge = registry.getSingleMetric(CIRCUIT_BREAKER_STATE)!;
    const valueAfter = async (state: BreakerState): Promise<number> => {
      metrics.setBreakerState('payment_gateway', state);
      return (await gauge.get()).values[0].value;
    };

    expect([await valueAfter('closed'), await valueAfter('half_open'), await valueAfter('open')]).toEqual([0, 1, 2]);
  });

  it('never throws into the caller when recording fails', async () => {
    const { metrics, registry, warn } = await build();
    vi.spyOn(registry.getSingleMetric(ORDERS_CREATED_TOTAL) as Counter, 'inc').mockImplementation(() => {
      throw new Error('registry exploded');
    });

    expect(() => metrics.recordOrderCreated('PENDING')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
