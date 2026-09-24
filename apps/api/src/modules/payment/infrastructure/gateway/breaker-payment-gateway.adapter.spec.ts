import type { ClsService } from 'nestjs-cls';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import {
  PaymentGatewayError,
  type GatewaySession,
  type PaymentGatewayPort,
} from '../../application/ports/payment-gateway.port';
import { BreakerPaymentGateway, PAYMENT_GATEWAY_BREAKER } from './breaker-payment-gateway.adapter';

const SESSION: GatewaySession = { providerSessionId: 'cs_test_1', redirectUrl: 'https://pay.test/1' };
const CHECKOUT = { orderId: 'o1', amountMinor: 100, currency: 'usd' };

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
  // Local CPU work: behind the breaker, an API outage would also reject the webhooks that still
  // settle orders while the API is down.
  it('verifies webhooks without the breaker, so a provider API outage cannot stop settlement', () => {
    const { gateway } = build(refusing);

    expect(gateway.verifyAndParseEvent(Buffer.from('{}'), {})).toMatchObject({ kind: 'valid' });
  });

  // PaymentGatewayError is the port's word for "the provider did not answer": checkout turns it into
  // a 502 and the sweeps retry. A fabricated status instead would read as "not paid" to reconcile.
  it('reports every refused call as a provider fault without reaching the provider', async () => {
    const { inner, gateway } = build(refusing);

    const errors = await Promise.all(
      [gateway.createSession(CHECKOUT), gateway.getPaymentStatus('cs_test_1'), gateway.expireSession('cs_test_1')].map(
        (call) => call.catch((e: unknown) => e),
      ),
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).cause).toBeInstanceOf(DownstreamUnavailableError);
    }
    expect(inner.createSession).not.toHaveBeenCalled();
    expect(inner.getPaymentStatus).not.toHaveBeenCalled();
    expect(inner.expireSession).not.toHaveBeenCalled();
  });

  // Re-wrapping would bury the provider detail the checkout log needs to diagnose an outage.
  it("leaves the gateway's own error alone rather than relabelling it", async () => {
    const { inner, gateway } = build(passThrough);
    const raised = new PaymentGatewayError('Stripe checkout session create failed (api_error)');
    inner.createSession.mockRejectedValueOnce(raised);

    await expect(gateway.createSession(CHECKOUT)).rejects.toBe(raised);
  });
});

// The wiring in payment.module.ts: a hanging provider is the failure the breaker exists for, and it
// must still arrive at the caller as an ordinary provider fault.
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
    const factory = new CircuitBreakerFactory(fakeConfigService(values), fakeMetricsPort(), fakePinoLogger(), {
      exit: <T>(run: () => T): T => run(),
    } as unknown as ClsService);
    return build(factory.create(PAYMENT_GATEWAY_BREAKER));
  }

  it('turns a provider that never answers into a provider fault, not a hung request', async () => {
    const { inner, gateway } = buildWired();
    inner.createSession.mockReturnValueOnce(new Promise<never>(() => {}));

    const error = await gateway.createSession(CHECKOUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentGatewayError);
    const cause = (error as PaymentGatewayError).cause;
    expect(cause).toBeInstanceOf(DownstreamUnavailableError);
    expect((cause as DownstreamUnavailableError).reason).toBe('timeout');
  });
});
