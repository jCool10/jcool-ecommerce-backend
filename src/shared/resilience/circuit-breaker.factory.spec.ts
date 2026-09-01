import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { CircuitBreakerFactory } from './circuit-breaker.factory';
import { DownstreamUnavailableError } from './outbound-call.port';

// Short enough to keep the suite quick, long enough that a loaded machine does not trip the
// timeout on a call meant to succeed.
const TIMEOUT_MS = 80;
const RESET_MS = 100;
const BREAKER = 'probe';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function build(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'resilience.breaker.enabled': true,
    'resilience.breaker.timeoutMs': TIMEOUT_MS,
    'resilience.breaker.errorThresholdPercentage': 50,
    'resilience.breaker.resetTimeoutMs': RESET_MS,
    'resilience.breaker.rollingWindowMs': 2000,
    // Two calls, so one failure cannot open the circuit on its own — the smallest setting that
    // still exercises the volume gate.
    'resilience.breaker.volumeThreshold': 2,
    ...overrides,
  };
  const metrics = {
    setBreakerState: vi.fn<MetricsPort['setBreakerState']>(),
    recordBreakerTransition: vi.fn<MetricsPort['recordBreakerTransition']>(),
    recordBreakerCall: vi.fn<MetricsPort['recordBreakerCall']>(),
  };
  const config = { getOrThrow: (key: string) => values[key] } as unknown as ConfigService;
  return { factory: new CircuitBreakerFactory(config, metrics as unknown as MetricsPort), metrics };
}

/** Stands in for the service on the other side of the network: it can fail, hang, or recover. */
class FakeDownstream {
  calls = 0;
  private failures = 0;
  private hangMs = 0;

  failNext(count: number): void {
    this.failures = count;
  }

  hangFor(ms: number): void {
    this.hangMs = ms;
  }

  recover(): void {
    this.failures = 0;
    this.hangMs = 0;
  }

  async call(): Promise<string> {
    this.calls += 1;
    if (this.hangMs > 0) {
      await sleep(this.hangMs);
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('downstream boom');
    }
    return 'ok';
  }
}

async function trip(call: { run<T>(task: () => Promise<T>): Promise<T> }, downstream: FakeDownstream): Promise<void> {
  downstream.failNext(2);
  await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');
  await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');
}

describe('CircuitBreakerFactory', () => {
  it('publishes the closed state up front, so the series exists before anything fails', () => {
    const { factory, metrics } = build();
    factory.create(BREAKER);
    expect(metrics.setBreakerState).toHaveBeenCalledWith(BREAKER, 'closed');
  });

  it('passes the downstream own error through unchanged while it stays closed', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    downstream.failNext(1);

    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // Only the breaker's own verdict is translated; a downstream that answered "no" answered.
    expect(error).not.toBeInstanceOf(DownstreamUnavailableError);
    expect((error as Error).message).toBe('downstream boom');
  });

  it('opens after repeated failures and then refuses without reaching the downstream', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);

    await trip(call, downstream);
    expect(metrics.recordBreakerTransition).toHaveBeenCalledWith(BREAKER, 'open');
    expect(metrics.setBreakerState).toHaveBeenCalledWith(BREAKER, 'open');

    const callsBeforeRefusal = downstream.calls;
    downstream.recover();
    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // The whole point of open: the request costs nothing downstream and returns immediately.
    expect(downstream.calls).toBe(callsBeforeRefusal);
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('open');
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(BREAKER, 'rejected');
  });

  it('lets exactly one trial call through after the reset window and closes on its success', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);

    await trip(call, downstream);
    downstream.recover();
    const callsWhileOpen = downstream.calls;
    await sleep(RESET_MS + 40);

    expect(metrics.setBreakerState).toHaveBeenCalledWith(BREAKER, 'half_open');
    await expect(call.run(() => downstream.call())).resolves.toBe('ok');

    expect(downstream.calls).toBe(callsWhileOpen + 1);
    expect(metrics.recordBreakerTransition).toHaveBeenCalledWith(BREAKER, 'closed');
  });

  it('goes straight back to open when the trial call still fails', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);

    await trip(call, downstream);
    await sleep(RESET_MS + 40);
    downstream.failNext(1);
    await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');

    // One failed probe re-opens the circuit on its own — the volume threshold does not apply to it,
    // or a half-open breaker would need a burst of traffic to decide anything.
    const reopens = metrics.recordBreakerTransition.mock.calls.filter(([, to]) => to === 'open');
    expect(reopens).toHaveLength(2);
    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
  });

  it('admits only one of several concurrent calls while half-open', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);

    await trip(call, downstream);
    downstream.recover();
    const callsWhileOpen = downstream.calls;
    await sleep(RESET_MS + 40);

    const results = await Promise.allSettled([1, 2, 3].map(() => call.run(() => downstream.call())));

    // The probe is a probe, not an opening of the floodgates: a burst arriving the moment the reset
    // window elapses must not become a second stampede against a downstream that is still fragile.
    expect(downstream.calls).toBe(callsWhileOpen + 1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('abandons a call that outlives the timeout and counts it as a timeout, not a plain failure', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    downstream.hangFor(TIMEOUT_MS * 3);

    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // A downstream that hangs rather than errors would otherwise never trip anything: no call fails,
    // we simply stop having request slots. The timeout is what turns hanging into a countable failure.
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('timeout');
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(BREAKER, 'timeout');
    expect(metrics.recordBreakerCall).not.toHaveBeenCalledWith(BREAKER, 'failure');

    // The abandoned call is still running; let it finish inside the test that started it.
    await sleep(TIMEOUT_MS * 3);
  });

  it('leaves the circuit closed for rejections the caller does not blame on the downstream', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER, {
      isDownstreamFault: (error) => (error as Error).message !== 'downstream boom',
    });
    downstream.failNext(6);

    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');
    }

    // A service that keeps rejecting our requests is a service that keeps answering. Counting those
    // would open the circuit on a healthy dependency and make a run of bad requests everyone's outage.
    expect(metrics.recordBreakerTransition).not.toHaveBeenCalledWith(BREAKER, 'open');
    downstream.recover();
    await expect(call.run(() => downstream.call())).resolves.toBe('ok');
  });

  it('refuses calls once shut down rather than leaking a raw breaker error', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    factory.onApplicationShutdown();

    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // A call landing mid-drain is refused, not attempted — the same thing an open circuit does, and
    // callers translate it the same way. Left raw it would surface as a 500.
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('open');
    expect(downstream.calls).toBe(0);
  });

  it('hands back the same breaker for a name, so both callers share one view of the downstream', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const first = factory.create(BREAKER);
    const second = factory.create(BREAKER);

    await trip(first, downstream);

    const error = await second.run(() => downstream.call()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
  });

  it('enforces nothing while the kill-switch is off', async () => {
    const { factory, metrics } = build({ 'resilience.breaker.enabled': false });
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    downstream.failNext(5);

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');
    }

    expect(downstream.calls).toBe(5);
    expect(metrics.recordBreakerCall).not.toHaveBeenCalled();
  });
});
