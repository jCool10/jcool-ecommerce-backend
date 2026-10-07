import type { ClsService } from 'nestjs-cls';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerFactory, DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import {
  PaymentGatewayError,
  type GatewaySession,
  type PaymentGatewayPort,
} from '../../application/ports/payment-gateway.port';
import {
  BreakerPaymentGateway,
  PAYMENT_CAPTURE_BREAKER,
  PAYMENT_GATEWAY_BREAKER,
  guardPaymentGateway,
} from './breaker-payment-gateway.adapter';
import { isStripeUnavailable } from './stripe-fault-classification';

const SESSION: GatewaySession = { providerSessionId: 'cs_test_1', redirectUrl: 'https://pay.test/1' };
const CHECKOUT = { orderId: 'o1', amountMinor: 100, currency: 'usd' };

function fakeInner() {
  return {
    provider: 'stripe',
    createSession: vi.fn().mockResolvedValue(SESSION),
    verifyAndParseEvent: vi.fn().mockReturnValue({ kind: 'valid', providerEventId: 'evt_1', type: 'x', payload: {} }),
    getPaymentStatus: vi.fn().mockResolvedValue({ status: 'PAID', intentId: 'pi_1' }),
    retrieveSession: vi.fn().mockResolvedValue({ status: 'PENDING', redirectUrl: SESSION.redirectUrl }),
    expireSession: vi.fn().mockResolvedValue(undefined),
    retrieveAuthorization: vi.fn().mockResolvedValue({ sessionStatus: 'open' }),
    capture: vi.fn().mockResolvedValue({ kind: 'captured' }),
    void: vi.fn().mockResolvedValue('voided'),
  } satisfies PaymentGatewayPort;
}

function build(breaker: OutboundCall, captureBreaker: OutboundCall = breaker) {
  const inner = fakeInner();
  return { inner, gateway: new BreakerPaymentGateway(inner, breaker, captureBreaker) };
}

const passThrough: OutboundCall = { run: (task) => task() };
const refusing: OutboundCall = {
  run: () => Promise.reject(new DownstreamUnavailableError(PAYMENT_GATEWAY_BREAKER, 'open')),
};

function recording(name: string, log: string[]): OutboundCall {
  return {
    run: (task) => {
      log.push(name);
      return task();
    },
  };
}

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
      [
        gateway.createSession(CHECKOUT),
        gateway.getPaymentStatus('cs_test_1'),
        gateway.retrieveSession('cs_test_1'),
        gateway.expireSession('cs_test_1'),
        gateway.retrieveAuthorization('cs_test_1'),
        gateway.capture('pi_1', 'capture:p1:0'),
        gateway.void('pi_1', 'void:p1:0'),
      ].map((call) => call.catch((e: unknown) => e)),
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).cause).toBeInstanceOf(DownstreamUnavailableError);
    }
    for (const call of [
      inner.createSession,
      inner.getPaymentStatus,
      inner.retrieveSession,
      inner.expireSession,
      inner.retrieveAuthorization,
      inner.capture,
      inner.void,
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  // A capture may legitimately take far longer than a session create; sharing one breaker would cut
  // it off early and trip the circuit checkout and the webhook depend on.
  it('sends only capture and void through the capture breaker', async () => {
    const log: string[] = [];
    const { gateway } = build(recording('gateway', log), recording('capture', log));

    await gateway.createSession(CHECKOUT);
    await gateway.getPaymentStatus('cs_test_1');
    await gateway.retrieveSession('cs_test_1');
    await gateway.expireSession('cs_test_1');
    await gateway.retrieveAuthorization('cs_test_1');
    await gateway.capture('pi_1', 'capture:p1:0');
    await gateway.void('pi_1', 'void:p1:0');

    expect(log).toEqual(['gateway', 'gateway', 'gateway', 'gateway', 'gateway', 'capture', 'capture']);
  });

  // Re-wrapping would bury the provider detail the checkout log needs to diagnose an outage, and
  // would drop the fresh-key flag the capture caller acts on.
  it("leaves the gateway's own error alone rather than relabelling it", async () => {
    const { inner, gateway } = build(passThrough);
    const raised = new PaymentGatewayError('Stripe checkout session create failed (api_error)');
    const rotate = new PaymentGatewayError('Stripe capture failed', undefined, { retryWithFreshKey: true });
    inner.createSession.mockRejectedValueOnce(raised);
    inner.capture.mockRejectedValueOnce(rotate);

    await expect(gateway.createSession(CHECKOUT)).rejects.toBe(raised);
    await expect(gateway.capture('pi_1', 'capture:p1:0')).rejects.toBe(rotate);
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

describe('guardPaymentGateway', () => {
  const SLOW_MS = 4_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  // Built as payment.module builds it: the shared 3s default, and a capture bound of 10s per request.
  function buildAsModule() {
    vi.useFakeTimers();
    const metrics = fakeMetricsPort();
    const factory = new CircuitBreakerFactory(
      fakeConfigService({
        'resilience.breaker.enabled': true,
        'resilience.breaker.timeoutMs': 3_000,
        'resilience.breaker.errorThresholdPercentage': 50,
        'resilience.breaker.resetTimeoutMs': 30_000,
        'resilience.breaker.rollingWindowMs': 10_000,
        'resilience.breaker.volumeThreshold': 5,
      }),
      metrics,
      fakePinoLogger(),
      { exit: <T>(run: () => T): T => run() } as unknown as ClsService,
    );
    const inner = fakeInner();
    const gateway = guardPaymentGateway(inner, factory, {
      captureTimeoutMs: 10_000,
      isDownstreamFault: isStripeUnavailable,
    });
    return { inner, gateway, metrics };
  }

  const answerAfter = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('lets a capture that is slow but inside its budget finish', async () => {
    const { inner, gateway, metrics } = buildAsModule();
    inner.capture.mockReturnValueOnce(answerAfter(SLOW_MS, { kind: 'captured' as const }));

    const pending = gateway.capture('pi_1', 'capture:p1:0');
    await vi.advanceTimersByTimeAsync(SLOW_MS);

    await expect(pending).resolves.toEqual({ kind: 'captured' });
    expect(inner.capture).toHaveBeenCalledTimes(1);
    expect(metrics.recordBreakerCall.mock.calls).toEqual([[PAYMENT_CAPTURE_BREAKER, 'success']]);
  });

  it('still abandons a session create at the shared 3s', async () => {
    const { inner, gateway } = buildAsModule();
    inner.createSession.mockReturnValueOnce(answerAfter(SLOW_MS, SESSION));

    const pending = gateway.createSession(CHECKOUT).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    const error = await pending;

    expect(error).toBeInstanceOf(PaymentGatewayError);
    const cause = (error as PaymentGatewayError).cause;
    expect(cause).toBeInstanceOf(DownstreamUnavailableError);
    expect((cause as DownstreamUnavailableError).reason).toBe('timeout');
  });
});
