import { trace } from '@opentelemetry/api';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it } from 'vitest';
import { useInMemoryTracer } from '../testing/in-memory-tracer';
import { CircuitBreakerFactory } from './circuit-breaker.factory';
import { DownstreamUnavailableError } from './outbound-call.port';

// Long enough that a loaded machine does not trip the timeout on a call meant to succeed.
const TIMEOUT_MS = 80;
const RESET_MS = 100;
const BREAKER = 'probe';

const cls = ClsServiceManager.getClsService();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function build(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'resilience.breaker.enabled': true,
    'resilience.breaker.timeoutMs': TIMEOUT_MS,
    'resilience.breaker.errorThresholdPercentage': 50,
    'resilience.breaker.resetTimeoutMs': RESET_MS,
    'resilience.breaker.rollingWindowMs': 2000,
    // Smallest setting that still exercises the volume gate: one failure cannot open the circuit.
    'resilience.breaker.volumeThreshold': 2,
    ...overrides,
  };
  const metrics = fakeMetricsPort();
  const logger = fakePinoLogger();
  const factory = new CircuitBreakerFactory(fakeConfigService(values), metrics, logger, cls);
  return { factory, metrics, logger };
}

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
  it('publishes the closed state as soon as the breaker is created', () => {
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

    expect(downstream.calls).toBe(callsBeforeRefusal);
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('open');
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(BREAKER, 'rejected');
  });

  it('lets one trial call through after the reset window and closes on success', async () => {
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

    // One failed probe re-opens the circuit on its own: the volume threshold does not apply to it,
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

    // A burst arriving the moment the reset window elapses must not stampede a fragile downstream.
    expect(downstream.calls).toBe(callsWhileOpen + 1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('counts a call that outlives the timeout as a timeout, not a failure', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    downstream.hangFor(TIMEOUT_MS * 3);

    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // A hanging downstream fails no call, it just eats request slots; the timeout is what makes it countable.
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('timeout');
    expect(metrics.recordBreakerCall).toHaveBeenCalledWith(BREAKER, 'timeout');
    expect(metrics.recordBreakerCall).not.toHaveBeenCalledWith(BREAKER, 'failure');

    // The abandoned call is still running; let it finish inside the test that started it.
    await sleep(TIMEOUT_MS * 3);
  });

  it('stays closed on rejections the caller does not blame on the downstream', async () => {
    const { factory, metrics } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER, {
      isDownstreamFault: (error) => (error as Error).message !== 'downstream boom',
    });
    downstream.failNext(6);

    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(call.run(() => downstream.call())).rejects.toThrow('downstream boom');
    }

    expect(metrics.recordBreakerTransition).not.toHaveBeenCalledWith(BREAKER, 'open');
    downstream.recover();
    await expect(call.run(() => downstream.call())).resolves.toBe('ok');
  });

  it('refuses calls with DownstreamUnavailableError once shut down', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    factory.onApplicationShutdown();

    const error = await call.run(() => downstream.call()).catch((e: unknown) => e);

    // Left raw, opossum's shutdown error would surface to callers as a 500 instead of a refusal.
    expect(error).toBeInstanceOf(DownstreamUnavailableError);
    expect((error as DownstreamUnavailableError).reason).toBe('open');
    expect(downstream.calls).toBe(0);
  });

  it('hands back the same breaker for the same name', async () => {
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

// A refusal makes no network call, so nothing but the breaker's own span records it.
describe('CircuitBreakerFactory tracing', () => {
  const exporter = useInMemoryTracer();

  const spanNamed = (name: string) => exporter.getFinishedSpans().filter((span) => span.name === name);

  it('records a refused call as a span of its own', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    await trip(call, downstream);
    exporter.reset();

    await expect(call.run(() => downstream.call())).rejects.toBeInstanceOf(DownstreamUnavailableError);

    const spans = spanNamed(`breaker:${BREAKER}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      'breaker.name': BREAKER,
      'breaker.state': 'open',
      'breaker.result': 'rejected',
    });
  });

  it('marks the trial call half_open on its span', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    await trip(call, downstream);
    downstream.recover();
    await sleep(RESET_MS + 40);
    exporter.reset();

    await expect(call.run(() => downstream.call())).resolves.toBe('ok');

    expect(spanNamed(`breaker:${BREAKER}`)[0].attributes).toMatchObject({
      'breaker.state': 'half_open',
      'breaker.result': 'success',
    });
  });

  // opossum schedules the half-open timer from inside the call that tripped the breaker, so its
  // callback inherits that call's CLS store and its already-ended span unless it is detached.
  it('keeps the timer-driven half-open off the call that tripped the breaker', async () => {
    const { factory, logger } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    // What the pino mixin would stamp on each transition line.
    const seenAtLog: Array<[string | undefined, boolean]> = [];
    logger.warn.mockImplementation(() => {
      seenAtLog.push([cls.getId(), trace.getActiveSpan() !== undefined]);
    });

    await cls.run(async () => {
      cls.set(CLS_ID, 'req-1');
      await trip(call, downstream);
    });
    await sleep(RESET_MS + 40);

    expect(seenAtLog).toEqual([
      ['req-1', true],
      [undefined, false],
    ]);
    const transitions = spanNamed(`breaker:${BREAKER}`)
      .flatMap((span) => span.events)
      .filter((event) => event.name === 'breaker.state_changed');
    expect(transitions.map((event) => event.attributes)).toEqual([
      { 'breaker.name': BREAKER, 'breaker.state': 'open' },
    ]);
  });
});
