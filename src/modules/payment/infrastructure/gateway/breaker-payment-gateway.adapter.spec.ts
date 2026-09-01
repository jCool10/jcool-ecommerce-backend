import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@shared/resilience';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import {
  PaymentGatewayError,
  type GatewaySession,
  type PaymentGatewayPort,
} from '../../application/ports/payment-gateway.port';
import { BreakerPaymentGateway, PAYMENT_GATEWAY_BREAKER } from './breaker-payment-gateway.adapter';

const SESSION: GatewaySession = { providerSessionId: 'cs_test_1', redirectUrl: 'https://pay.test/1' };

function build(breaker: OutboundCall) {
  const inner = {
    provider: 'stripe',
    createSession: vi.fn().mockResolvedValue(SESSION),
    verifyAndParseEvent: vi.fn().mockReturnValue({ kind: 'valid', providerEventId: 'evt_1', type: 'x', payload: {} }),
    getPaymentStatus: vi.fn().mockResolvedValue({ status: 'PAID', intentId: 'pi_1' }),
    expireSession: vi.fn().mockResolvedValue(undefined),
  } satisfies PaymentGatewayPort;
  return { inner, gateway: new BreakerPaymentGateway(inner, breaker) };
}

const passThrough: OutboundCall = { run: (task) => task() };
const refusing: OutboundCall = {
  run: () => Promise.reject(new DownstreamUnavailableError(PAYMENT_GATEWAY_BREAKER, 'open')),
};

describe('BreakerPaymentGateway', () => {
  it('records the provider of the gateway it wraps, not one of its own', () => {
    expect(build(passThrough).gateway.provider).toBe('stripe');
  });

  it('verifies webhooks without the breaker, so a provider API outage cannot stop settlement', () => {
    // The signature check is local CPU work. Behind the breaker, an outage of the gateway's API
    // would also reject the webhooks that same gateway keeps delivering — the one path that still
    // settles orders while its API is down.
    const { gateway } = build(refusing);

    expect(gateway.verifyAndParseEvent(Buffer.from('{}'), {})).toMatchObject({ kind: 'valid' });
  });

  it.each([
    [
      'createSession',
      (g: BreakerPaymentGateway) => g.createSession({ orderId: 'o1', amountMinor: 100, currency: 'usd' }),
    ],
    ['getPaymentStatus', (g: BreakerPaymentGateway) => g.getPaymentStatus('cs_test_1')],
    ['expireSession', (g: BreakerPaymentGateway) => g.expireSession('cs_test_1')],
  ])('reports a refused %s as a provider fault, so callers keep their existing handling', async (_name, invoke) => {
    const { inner, gateway } = build(refusing);

    const error = await invoke(gateway).catch((e: unknown) => e);

    // PaymentGatewayError is the port's word for "the provider did not answer": checkout turns it
    // into a 502, the reconcile sweep leaves the order for its next tick, and the expiry consumer
    // retries the message. A raw breaker error would be a 500 nobody expects.
    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect((error as PaymentGatewayError).cause).toBeInstanceOf(DownstreamUnavailableError);
    expect(inner.createSession).not.toHaveBeenCalled();
    expect(inner.getPaymentStatus).not.toHaveBeenCalled();
    expect(inner.expireSession).not.toHaveBeenCalled();
  });

  it('never answers a refused status query with a value', async () => {
    const { gateway } = build(refusing);

    // A fabricated UNKNOWN here reads as "not paid" to the reconcile sweep, which would then expire an
    // order the buyer may have paid for. Failing is the safe answer; degrading is not.
    await expect(gateway.getPaymentStatus('cs_test_1')).rejects.toThrow(PaymentGatewayError);
  });

  it('passes calls and answers through untouched while the circuit is closed', async () => {
    const { inner, gateway } = build(passThrough);

    await expect(gateway.createSession({ orderId: 'o1', amountMinor: 100, currency: 'usd' })).resolves.toEqual(SESSION);
    await expect(gateway.getPaymentStatus('cs_test_1')).resolves.toEqual({ status: 'PAID', intentId: 'pi_1' });
    expect(inner.createSession).toHaveBeenCalledWith({ orderId: 'o1', amountMinor: 100, currency: 'usd' });
  });

  it('leaves the gateway own error alone rather than relabelling it', async () => {
    const { inner, gateway } = build(passThrough);
    const raised = new PaymentGatewayError('Stripe checkout session create failed (api_error)');
    inner.createSession.mockRejectedValueOnce(raised);

    // Re-wrapping would bury the provider detail the checkout log needs to diagnose an outage.
    await expect(gateway.createSession({ orderId: 'o1', amountMinor: 100, currency: 'usd' })).rejects.toBe(raised);
  });
});

// The wiring these two halves form in payment.module.ts: a hanging provider is the failure the
// breaker exists for, and it must still arrive at the caller as an ordinary provider fault.
describe('BreakerPaymentGateway over a real breaker', () => {
  const TIMEOUT_MS = 60;

  function buildWired() {
    const values: Record<string, unknown> = {
      'resilience.breaker.enabled': true,
      'resilience.breaker.timeoutMs': TIMEOUT_MS,
      'resilience.breaker.errorThresholdPercentage': 50,
      'resilience.breaker.resetTimeoutMs': 100,
      'resilience.breaker.rollingWindowMs': 2000,
      'resilience.breaker.volumeThreshold': 2,
    };
    const metrics = {
      setBreakerState: vi.fn(),
      recordBreakerTransition: vi.fn(),
      recordBreakerCall: vi.fn(),
    } as unknown as MetricsPort;
    const factory = new CircuitBreakerFactory(
      { getOrThrow: (key: string) => values[key] } as unknown as ConfigService,
      metrics,
    );
    return build(factory.create(PAYMENT_GATEWAY_BREAKER));
  }

  it('turns a provider that never answers into a provider fault, not a hung request', async () => {
    const { inner, gateway } = buildWired();
    const hang = new Promise<never>(() => {});
    inner.createSession.mockReturnValueOnce(hang);

    const error = await gateway
      .createSession({ orderId: 'o1', amountMinor: 100, currency: 'usd' })
      .catch((e: unknown) => e);

    // Without the timeout this call would hold its request slot for as long as the SDK allows, and
    // an outage on their side would become one on ours.
    expect(error).toBeInstanceOf(PaymentGatewayError);
    const cause = (error as PaymentGatewayError).cause;
    expect(cause).toBeInstanceOf(DownstreamUnavailableError);
    expect((cause as DownstreamUnavailableError).reason).toBe('timeout');
  });
});
