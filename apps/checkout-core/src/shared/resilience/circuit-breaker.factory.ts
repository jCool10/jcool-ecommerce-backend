import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ROOT_CONTEXT, context as otelContext, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import CircuitBreaker from 'opossum';
import { METRICS, type BreakerState, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { withSpan } from '@shared/observability/tracing/tracer';
import { DownstreamUnavailableError, type OutboundCall } from './outbound-call.port';

const LOG_CONTEXT = 'CircuitBreaker';

// Guarding a thunk rather than one fixed function lets a single breaker front every method of a
// dependency — the right grain, since what it tracks is downstream health, not one endpoint's.
type Task = () => Promise<unknown>;
type TaskBreaker = CircuitBreaker<[Task], unknown>;

// opossum's own verdicts, raised for a call it never let reach the downstream or stopped waiting
// on. Anything else surfacing from `fire` came from the task itself.
const BREAKER_OPEN = 'EOPENBREAKER';
const CALL_TIMED_OUT = 'ETIMEDOUT';
// A breaker shut down with the process refuses exactly like an open one, and reports neither open
// nor closed; it just never reopens, which is of no use to a caller during a drain.
const BREAKER_SHUT_DOWN = 'ESHUTDOWN';

export interface BreakerOptions {
  /**
   * Whether a rejection counts against the downstream's health. Default: every rejection does.
   * A provider answering 4xx to malformed requests is answering; counting those opens the circuit on
   * a healthy dependency. Either way the rejection still reaches the caller — this only decides counting.
   */
  isDownstreamFault?: (error: unknown) => boolean;

  /**
   * Overrides the shared timeout for a dependency whose healthy latency is nothing like the rest —
   * a mail server against a payment API — where one number is wrong for one of them.
   */
  timeoutMs?: number;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

function stateOf(breaker: TaskBreaker): BreakerState {
  if (breaker.halfOpen) {
    return 'half_open';
  }
  return breaker.closed ? 'closed' : 'open';
}

class BreakerOutboundCall implements OutboundCall {
  constructor(
    private readonly name: string,
    private readonly breaker: TaskBreaker,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    // A refused call never reaches the network, so it leaves no auto-instrumented span behind and a
    // trace of a checkout during an outage would end at a 502 explaining nothing. State is read
    // before the call because the interesting one is `half_open` — the trial that decides recovery.
    return withSpan(`breaker:${this.name}`, async (span) => {
      span.setAttributes({ 'breaker.name': this.name, 'breaker.state': stateOf(this.breaker) });
      try {
        const value = (await this.breaker.fire(task)) as T;
        span.setAttribute('breaker.result', 'success');
        return value;
      } catch (error) {
        switch (codeOf(error)) {
          case BREAKER_OPEN:
          case BREAKER_SHUT_DOWN:
            span.setAttribute('breaker.result', 'rejected');
            throw new DownstreamUnavailableError(this.name, 'open', error);
          case CALL_TIMED_OUT:
            span.setAttribute('breaker.result', 'timeout');
            // The task keeps running: the timeout abandons our wait, it cannot cancel a request
            // already on the wire. What it buys back is the request slot.
            throw new DownstreamUnavailableError(this.name, 'timeout', error);
          default:
            span.setAttribute('breaker.result', 'error');
            throw error;
        }
      }
    });
  }
}

/**
 * State is in-memory, so each replica learns the downstream's health from its own traffic. Sharing
 * it through Redis would put a network dependency in the path whose whole job is surviving a
 * network dependency going down.
 */
@Injectable()
export class CircuitBreakerFactory implements OnApplicationShutdown {
  private readonly breakers = new Map<string, TaskBreaker>();
  private readonly options: CircuitBreaker.Options;

  constructor(
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {
    this.options = {
      // Off makes every guarded call a direct pass-through: no counting, no opening — and no
      // timeout either, so the call waits as long as the downstream's own client allows.
      enabled: config.getOrThrow<boolean>('resilience.breaker.enabled'),
      timeout: config.getOrThrow<number>('resilience.breaker.timeoutMs'),
      errorThresholdPercentage: config.getOrThrow<number>('resilience.breaker.errorThresholdPercentage'),
      resetTimeout: config.getOrThrow<number>('resilience.breaker.resetTimeoutMs'),
      rollingCountTimeout: config.getOrThrow<number>('resilience.breaker.rollingWindowMs'),
      volumeThreshold: config.getOrThrow<number>('resilience.breaker.volumeThreshold'),
    };
    logger.setContext(LOG_CONTEXT);
  }

  /**
   * `name` becomes a metric label, so it must come from a fixed set — never a per-call value. The
   * same name always returns the same breaker (two would learn the outage separately and contradict
   * each other on one gauge series), so options only take effect on the first `create` for a name.
   */
  create(name: string, options: BreakerOptions = {}): OutboundCall {
    const existing = this.breakers.get(name);
    if (existing) {
      return new BreakerOutboundCall(name, existing);
    }

    const { isDownstreamFault, timeoutMs } = options;
    const breaker = new CircuitBreaker<[Task], unknown>((task) => task(), {
      ...this.options,
      name,
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
      ...(isDownstreamFault && { errorFilter: (error: unknown) => !isDownstreamFault(error) }),
    });
    this.instrument(name, breaker);
    this.breakers.set(name, breaker);
    return new BreakerOutboundCall(name, breaker);
  }

  // Breakers hold a reset timer while open; shutting them down keeps a draining process from
  // flipping state (and writing metrics) on its way out. They stay in the map deliberately: a
  // `create` late in the drain must get the same dead breaker, not a live one nothing else sees.
  onApplicationShutdown(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
  }

  /**
   * The reset timer is scheduled from inside the call that tripped the breaker, so its callback
   * inherits that call's CLS store and its already-ended span. Left attached, the log line would
   * carry a stale requestId/traceId and the span event would land on an ended span (silently dropped).
   */
  private detached(run: () => void): void {
    otelContext.with(ROOT_CONTEXT, () => {
      this.cls.exit(run);
    });
  }

  private instrument(name: string, breaker: TaskBreaker): void {
    const entered = (state: BreakerState): void => {
      this.metrics.setBreakerState(name, state);
      this.metrics.recordBreakerTransition(name, state);
      // Present only for a transition a call caused — the only case where hanging it off a span says anything.
      trace.getActiveSpan()?.addEvent('breaker.state_changed', { 'breaker.name': name, 'breaker.state': state });
    };
    const fields = (state: BreakerState): Record<string, string> => ({ breaker: name, state });

    breaker.on('open', () => {
      entered('open');
      this.logger.warn(fields('open'), 'circuit opened — calls fail fast until the trial call after the reset window');
    });
    breaker.on('halfOpen', () => {
      this.detached(() => {
        entered('half_open');
        this.logger.warn(fields('half_open'), 'circuit half-open — one trial call decides whether it closes');
      });
    });
    breaker.on('close', () => {
      entered('closed');
      this.logger.info(fields('closed'), 'circuit closed — the downstream answered again');
    });

    // A rejection that `isDownstreamFault` disowns arrives here, not as a failure: the provider
    // answered, it just answered "no" to that one request.
    breaker.on('success', () => this.metrics.recordBreakerCall(name, 'success'));
    // An abandoned call emits `timeout` AND `failure`, so it is classified here instead of counted
    // from its own event — listening to both would count that one call twice.
    breaker.on('failure', (error: unknown) =>
      this.metrics.recordBreakerCall(name, codeOf(error) === CALL_TIMED_OUT ? 'timeout' : 'failure'),
    );
    breaker.on('reject', () => this.metrics.recordBreakerCall(name, 'rejected'));

    // Publish the closed series up front: otherwise an alert on "open" cannot tell a healthy breaker
    // from one that has never been exercised.
    this.metrics.setBreakerState(name, 'closed');
  }
}
