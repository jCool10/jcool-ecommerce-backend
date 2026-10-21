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
} from './breaker-payment-gateway.adapter';

const SESSION: GatewaySession = { providerSessionId: 'cs_test_1', redirectUrl: 'https://pay.test/1' };
const CHECKOUT = { orderId: 'o1', amountMinor: 100, currency: 'usd' };

function build(breaker: OutboundCall, captureBreaker: OutboundCall = breaker) {
  const inner = {
    provider: 'stripe',
    createSession: vi.fn().mockResolvedValue(SESSION),
    verifyAndParseEvent: vi.fn().mockReturnValue({ kind: 'valid', providerEventId: 'evt_1', type: 'x', payload: {} }),
    getPaymentStatus: vi.fn().mockResolvedValue({ status: 'PAID', intentId: 'pi_1' }),
    retrieveSession: vi.fn().mockResolvedValue({ status: 'PENDING', redirectUrl: SESSION.redirectUrl }),
    expireSession: vi.fn().mockResolvedValue(undefined),
    retrieveAuthorization: vi.fn().mockResolvedValue({ sessionStatus: 'open' }),
    captureIntent: vi.fn().mockResolvedValue({ kind: 'captured' }),
    voidIntent: vi.fn().mockResolvedValue('voided'),
  } satisfies PaymentGatewayPort;
  return { inner, gateway: new BreakerPaymentGateway(inner, breaker, captureBreaker) };
}

const passThrough: OutboundCall = { run: (task) => task() };
const refusing = (name: string): OutboundCall => ({
  run: () => Promise.reject(new DownstreamUnavailableError(name, 'open')),
});

describe('BreakerPaymentGateway', () => {
  // Local CPU work: behind the breaker, an API outage would also reject the webhooks that still
  // settle orders while the API is down.
  it('verifies webhooks without the breaker, so a provider API outage cannot stop settlement', () => {
    const { gateway } = build(refusing(PAYMENT_GATEWAY_BREAKER));

    expect(gateway.verifyAndParseEvent(Buffer.from('{}'), {})).toMatchObject({ kind: 'valid' });
  });

  // PaymentGatewayError is the port's word for "the provider did not answer": checkout turns it into
  // a 502 and the sweeps retry. A fabricated status instead would read as "not paid" to reconcile.
  it('reports every refused call as a provider fault without reaching the provider', async () => {
    const { inner, gateway } = build(refusing(PAYMENT_GATEWAY_BREAKER));

    const errors = await Promise.all(
      [
        gateway.createSession(CHECKOUT),
        gateway.getPaymentStatus('cs_test_1'),
        gateway.retrieveSession('cs_test_1'),
        gateway.expireSession('cs_test_1'),
        gateway.retrieveAuthorization('cs_test_1'),
      ].map((call) => call.catch((e: unknown) => e)),
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).cause).toBeInstanceOf(DownstreamUnavailableError);
    }
    expect(inner.createSession).not.toHaveBeenCalled();
    expect(inner.getPaymentStatus).not.toHaveBeenCalled();
    expect(inner.retrieveSession).not.toHaveBeenCalled();
    expect(inner.expireSession).not.toHaveBeenCalled();
    expect(inner.retrieveAuthorization).not.toHaveBeenCalled();
  });

  it('keeps capture and void on their own breaker, apart from checkout and webhooks', async () => {
    const { inner, gateway } = build(passThrough, refusing(PAYMENT_CAPTURE_BREAKER));

    await expect(gateway.captureIntent('pi_1', 'capture:1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(gateway.voidIntent('pi_1', 'void:1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(gateway.createSession(CHECKOUT)).resolves.toEqual(SESSION);
    expect(inner.captureIntent).not.toHaveBeenCalled();
    expect(inner.voidIntent).not.toHaveBeenCalled();
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
  const GATEWAY_TIMEOUT_MS = 3_000;
  const CAPTURE_TIMEOUT_MS = 10_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildWired() {
    const values: Record<string, unknown> = {
      'resilience.breaker.enabled': true,
      'resilience.breaker.timeoutMs': GATEWAY_TIMEOUT_MS,
      'resilience.breaker.errorThresholdPercentage': 50,
      'resilience.breaker.resetTimeoutMs': 100,
      'resilience.breaker.rollingWindowMs': 60_000,
      'resilience.breaker.volumeThreshold': 2,
    };
    const metrics = fakeMetricsPort();
    const factory = new CircuitBreakerFactory(fakeConfigService(values), metrics, fakePinoLogger(), {
      exit: <T>(run: () => T): T => run(),
    } as unknown as ClsService);
    const built = build(
      factory.create(PAYMENT_GATEWAY_BREAKER),
      factory.create(PAYMENT_CAPTURE_BREAKER, { timeoutMs: 2 * CAPTURE_TIMEOUT_MS + 1_000 }),
    );
    return { ...built, metrics };
  }

  const resolveAfter = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('turns a provider that never answers into a provider fault, not a hung request', async () => {
    vi.useFakeTimers();
    const { inner, gateway } = buildWired();
    inner.createSession.mockReturnValueOnce(new Promise<never>(() => {}));

    const pending = gateway.createSession(CHECKOUT).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(GATEWAY_TIMEOUT_MS);
    const error = await pending;

    expect(error).toBeInstanceOf(PaymentGatewayError);
    const cause = (error as PaymentGatewayError).cause;
    expect(cause).toBeInstanceOf(DownstreamUnavailableError);
    expect((cause as DownstreamUnavailableError).reason).toBe('timeout');
  });

  // A slow capture still within its own budget must land, or the saga retries a capture that succeeded.
  it('lets a capture slower than the checkout breaker allows finish on its own breaker', async () => {
    vi.useFakeTimers();
    const { inner, gateway, metrics } = buildWired();
    inner.captureIntent.mockReturnValueOnce(resolveAfter(4_000, { kind: 'captured' as const }));

    const captured = gateway.captureIntent('pi_1', 'capture:1:0');
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(captured).resolves.toEqual({ kind: 'captured' });
    expect(inner.captureIntent).toHaveBeenCalledTimes(1);
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(PAYMENT_CAPTURE_BREAKER, 'success');
  });

  it('still cuts a session create off at the checkout breaker timeout', async () => {
    vi.useFakeTimers();
    const { inner, gateway } = buildWired();
    inner.createSession.mockReturnValueOnce(resolveAfter(4_000, SESSION));

    const pending = gateway.createSession(CHECKOUT).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(GATEWAY_TIMEOUT_MS);
    const error = await pending;

    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect((error as PaymentGatewayError).cause).toMatchObject({ reason: 'timeout' });
  });
});
