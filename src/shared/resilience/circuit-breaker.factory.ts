import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import CircuitBreaker from 'opossum';
import { METRICS, type BreakerState, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { DownstreamUnavailableError, type OutboundCall } from './outbound-call.port';

// The breaker guards a thunk rather than one fixed function, so a single breaker can front every
// method of a dependency. That is the right grain: what it tracks is the health of the downstream,
// which those methods share, not the health of one endpoint.
type Task = () => Promise<unknown>;
type TaskBreaker = CircuitBreaker<[Task], unknown>;

// opossum's own verdicts: the codes it raises for a call it never let reach the downstream, or
// stopped waiting on. Anything else surfacing from `fire` came from the task itself.
const BREAKER_OPEN = 'EOPENBREAKER';
const CALL_TIMED_OUT = 'ETIMEDOUT';
// A breaker shut down with the process refuses exactly like an open one. The only difference is that
// it will never reopen, which is of no use to a caller during a drain.
const BREAKER_SHUT_DOWN = 'ESHUTDOWN';

export interface BreakerOptions {
  /**
   * Whether a rejection is evidence about the downstream's health. Default: every rejection is.
   *
   * Worth overriding wherever the caller can tell "they refused this request" from "they are
   * struggling". A provider answering 4xx to a handful of malformed requests is answering; counting
   * those opens the circuit on a healthy dependency and turns a few bad requests into an outage for
   * everyone. The rejection still reaches the caller either way — this only decides whether it is
   * counted.
   */
  isDownstreamFault?: (error: unknown) => boolean;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

class BreakerOutboundCall implements OutboundCall {
  constructor(
    private readonly name: string,
    private readonly breaker: TaskBreaker,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    try {
      return (await this.breaker.fire(task)) as T;
    } catch (error) {
      switch (codeOf(error)) {
        case BREAKER_OPEN:
        case BREAKER_SHUT_DOWN:
          throw new DownstreamUnavailableError(this.name, 'open', error);
        case CALL_TIMED_OUT:
          // The task keeps running in the background — the timeout abandons our wait, it cannot
          // cancel a request already on the wire. What it buys is the request slot back.
          throw new DownstreamUnavailableError(this.name, 'timeout', error);
        default:
          throw error;
      }
    }
  }
}

/**
 * Hands out circuit breakers for calls that leave this process.
 *
 * A failing downstream is dangerous less for its own errors than for its latency: every caller
 * waiting out a timeout holds one of our request slots, so their outage becomes ours. Once the
 * failure rate crosses the threshold the breaker opens and calls fail immediately, which frees
 * those slots and stops adding load to something already struggling. After `resetTimeout` one
 * trial call decides whether to close again.
 *
 * State is in-memory, so each replica learns the downstream's health from its own traffic. Sharing
 * it through Redis would put a network dependency in the path whose whole job is surviving a
 * network dependency going down.
 */
@Injectable()
export class CircuitBreakerFactory implements OnApplicationShutdown {
  private readonly logger = new Logger(CircuitBreakerFactory.name);
  private readonly breakers = new Map<string, TaskBreaker>();
  private readonly options: CircuitBreaker.Options;

  constructor(
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
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
  }

  /**
   * `name` becomes a metric label, so it must come from a fixed set — never a per-call value. The
   * same name always returns the same breaker: two instances would each have to learn the outage
   * separately, and would report contradicting states on one gauge series. Options therefore only
   * take effect on the first `create` for a name.
   */
  create(name: string, options: BreakerOptions = {}): OutboundCall {
    const existing = this.breakers.get(name);
    if (existing) {
      return new BreakerOutboundCall(name, existing);
    }

    const { isDownstreamFault } = options;
    const breaker = new CircuitBreaker<[Task], unknown>((task) => task(), {
      ...this.options,
      name,
      ...(isDownstreamFault && { errorFilter: (error: unknown) => !isDownstreamFault(error) }),
    });
    this.instrument(name, breaker);
    this.breakers.set(name, breaker);
    return new BreakerOutboundCall(name, breaker);
  }

  // Breakers hold a reset timer while open; shutting them down keeps a draining process from
  // flipping state (and writing metrics) on its way out. They stay in the map deliberately — a
  // `create` arriving late in the drain must hand back the same dead breaker, not a live one whose
  // state nothing else can see.
  onApplicationShutdown(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
  }

  private instrument(name: string, breaker: TaskBreaker): void {
    const entered = (state: BreakerState): void => {
      this.metrics.setBreakerState(name, state);
      this.metrics.recordBreakerTransition(name, state);
    };

    breaker.on('open', () => {
      entered('open');
      this.logger.error(`circuit opened for ${name} — calls fail fast until the trial call after the reset window`);
    });
    breaker.on('halfOpen', () => entered('half_open'));
    breaker.on('close', () => {
      entered('closed');
      this.logger.log(`circuit closed for ${name} — the downstream answered again`);
    });

    // A rejection that `isDownstreamFault` disowns arrives here rather than as a failure, which is
    // the honest reading of it: the provider answered, it just answered "no" to that one request.
    breaker.on('success', () => this.metrics.recordBreakerCall(name, 'success'));
    // An abandoned call emits `timeout` AND `failure`, so it is classified here instead of counted
    // from its own event — listening to both would count that one call twice.
    breaker.on('failure', (error: unknown) =>
      this.metrics.recordBreakerCall(name, codeOf(error) === CALL_TIMED_OUT ? 'timeout' : 'failure'),
    );
    breaker.on('reject', () => this.metrics.recordBreakerCall(name, 'rejected'));

    // Publish the closed series up front: an alert on "open" cannot tell a healthy breaker from a
    // breaker that has never been exercised if the series only appears once something has failed.
    this.metrics.setBreakerState(name, 'closed');
  }
}
