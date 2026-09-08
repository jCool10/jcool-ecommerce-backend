import type { ConfigService } from '@nestjs/config';
import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { CircuitBreakerFactory } from './circuit-breaker.factory';
import { DownstreamUnavailableError } from './outbound-call.port';

// Long enough that a loaded machine does not trip the timeout on a call meant to succeed.
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
    // Smallest setting that still exercises the volume gate: one failure cannot open the circuit.
    'resilience.breaker.volumeThreshold': 2,
    ...overrides,
  };
  const metrics = {
    setBreakerState: vi.fn<MetricsPort['setBreakerState']>(),
    recordBreakerTransition: vi.fn<MetricsPort['recordBreakerTransition']>(),
    recordBreakerCall: vi.fn<MetricsPort['recordBreakerCall']>(),
  };
  const config = { getOrThrow: (key: string) => values[key] } as unknown as ConfigService;
  const logger = { warn: vi.fn(), info: vi.fn() };
  // The real one drops the caller out of the request store; here there is none to drop out of.
  const cls = { exit: <T>(run: () => T): T => run() } as unknown as ClsService;
  const factory = new CircuitBreakerFactory(
    config,
    metrics as unknown as MetricsPort,
    logger as unknown as PinoLogger,
    cls,
  );
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

  it('abandons a call that outlives the timeout and counts it as a timeout, not a plain failure', async () => {
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

    // Left raw, opossum's shutdown error would surface to callers as a 500 instead of a refusal.
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

// A real in-memory tracer, not a mock: a refusal makes no network call, so nothing else records it.
describe('CircuitBreakerFactory tracing', () => {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    otelContext.disable();
    trace.disable();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  beforeEach(() => exporter.reset());

  const spanNamed = (name: string) => exporter.getFinishedSpans().filter((span) => span.name === name);

  it('records a refused call as a span of its own, since it never reaches the network', async () => {
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

  it('marks the trial call half_open, so a trace shows which call was the probe', async () => {
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

  it('hangs the transition off the call that caused it', async () => {
    const { factory } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);

    await trip(call, downstream);
    // Past the reset window, so the timer-driven half-open has fired too. It must not add a second
    // event: the only span it could land on tripped the breaker a reset window ago and has ended.
    await sleep(RESET_MS + 40);

    const transitions = spanNamed(`breaker:${BREAKER}`)
      .flatMap((span) => span.events)
      .filter((event) => event.name === 'breaker.state_changed');
    expect(transitions).toHaveLength(1);
    expect(transitions[0].attributes).toMatchObject({ 'breaker.name': BREAKER, 'breaker.state': 'open' });
  });

  it('logs the timer-driven transition with no request context to misattribute it to', async () => {
    const { factory, logger } = build();
    const downstream = new FakeDownstream();
    const call = factory.create(BREAKER);
    // The pino mixin stamps requestId/traceId from whatever context the line is written in, so what
    // a transition can see at log time is what ends up on it.
    const contextAtLog: (string | undefined)[] = [];
    logger.warn.mockImplementation(() => {
      contextAtLog.push(trace.getActiveSpan()?.spanContext().spanId);
    });

    await trip(call, downstream);
    await sleep(RESET_MS + 40);

    const [openLine, halfOpenLine] = contextAtLog;
    expect(openLine).toBeDefined();
    expect(halfOpenLine).toBeUndefined();
  });
});
