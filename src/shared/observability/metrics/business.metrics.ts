import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Counter, Gauge, Histogram } from 'prom-client';
import type {
  BreakerCallResult,
  BreakerState,
  CacheResult,
  CartOperation,
  CompensationTrigger,
  ConsumeResult,
  DeadLetterReason,
  MailKind,
  MetricsPort,
  PublishResult,
  RefundOwedSource,
  SagaStep,
} from './metrics.port';
import {
  AUTH_EVENTS_TOTAL,
  CACHE_REBUILD_DURATION_SECONDS,
  CART_OPERATIONS_TOTAL,
  CATALOG_CACHE_OPERATIONS_TOTAL,
  CIRCUIT_BREAKER_CALLS_TOTAL,
  CIRCUIT_BREAKER_STATE,
  CIRCUIT_BREAKER_TRANSITIONS_TOTAL,
  MAIL_SEND_FAILURES_TOTAL,
  MEDIA_BYTES_RECLAIMED_TOTAL,
  MESSAGING_CONSUME_RETRIES_TOTAL,
  MESSAGING_CONSUME_TOTAL,
  MESSAGING_DLQ_TOTAL,
  MESSAGING_PUBLISH_TOTAL,
  ORDERS_CREATED_TOTAL,
  ORDER_VALUE_MINOR,
  PAYMENT_REFUND_OWED_TOTAL,
  RATE_LIMIT_REJECTIONS_TOTAL,
  RESERVATION_EXPIRY_TOTAL,
  RETENTION_ROWS_DELETED_TOTAL,
  RETENTION_SWEEP_DURATION_SECONDS,
  RETENTION_SWEEP_FAILURES_TOTAL,
  SAGA_COMPENSATION_TOTAL,
  SAGA_STEP_TOTAL,
} from './metric-definitions';

const LOG_CONTEXT = 'BusinessMetrics';

// A gauge holds a number, so the states are ordered by severity: an alert can fire on `>= 2`
// (open) without enumerating labels, and a graph reads as escalation.
const BREAKER_STATE_VALUES: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * prom-client implementation of MetricsPort. Every record is wrapped in `safely()` so a
 * telemetry failure can never break the business flow (ADR-0014). Injected as `METRICS`.
 */
@Injectable()
export class BusinessMetrics implements MetricsPort {
  constructor(
    @InjectMetric(ORDERS_CREATED_TOTAL) private readonly ordersCreated: Counter<string>,
    @InjectMetric(ORDER_VALUE_MINOR) private readonly orderValue: Histogram<string>,
    @InjectMetric(CART_OPERATIONS_TOTAL) private readonly cartOps: Counter<string>,
    @InjectMetric(AUTH_EVENTS_TOTAL) private readonly authEvents: Counter<string>,
    @InjectMetric(CATALOG_CACHE_OPERATIONS_TOTAL) private readonly catalogCacheOps: Counter<string>,
    @InjectMetric(MESSAGING_PUBLISH_TOTAL) private readonly eventsPublished: Counter<string>,
    @InjectMetric(MESSAGING_CONSUME_TOTAL) private readonly eventsConsumed: Counter<string>,
    @InjectMetric(MESSAGING_CONSUME_RETRIES_TOTAL) private readonly consumeRetries: Counter<string>,
    @InjectMetric(MESSAGING_DLQ_TOTAL) private readonly deadLetters: Counter<string>,
    @InjectMetric(SAGA_STEP_TOTAL) private readonly sagaSteps: Counter<string>,
    @InjectMetric(SAGA_COMPENSATION_TOTAL) private readonly compensations: Counter<string>,
    @InjectMetric(RESERVATION_EXPIRY_TOTAL) private readonly reservationExpiries: Counter<string>,
    @InjectMetric(PAYMENT_REFUND_OWED_TOTAL) private readonly refundsOwed: Counter<string>,
    @InjectMetric(MAIL_SEND_FAILURES_TOTAL) private readonly mailSendFailures: Counter<string>,
    @InjectMetric(RETENTION_ROWS_DELETED_TOTAL) private readonly retentionRowsDeleted: Counter<string>,
    @InjectMetric(RETENTION_SWEEP_DURATION_SECONDS) private readonly retentionSweepDuration: Histogram<string>,
    @InjectMetric(RETENTION_SWEEP_FAILURES_TOTAL) private readonly retentionSweepFailures: Counter<string>,
    @InjectMetric(MEDIA_BYTES_RECLAIMED_TOTAL) private readonly mediaBytesReclaimed: Counter<string>,
    @InjectMetric(CACHE_REBUILD_DURATION_SECONDS) private readonly cacheRebuildDuration: Histogram<string>,
    @InjectMetric(CIRCUIT_BREAKER_STATE) private readonly breakerState: Gauge<string>,
    @InjectMetric(CIRCUIT_BREAKER_TRANSITIONS_TOTAL) private readonly breakerTransitions: Counter<string>,
    @InjectMetric(CIRCUIT_BREAKER_CALLS_TOTAL) private readonly breakerCalls: Counter<string>,
    @InjectMetric(RATE_LIMIT_REJECTIONS_TOTAL) private readonly rateLimitRejections: Counter<string>,
    private readonly logger: PinoLogger,
  ) {}

  recordOrderCreated(status: string): void {
    this.safely('orders_created', () => this.ordersCreated.inc({ status }));
  }

  observeOrderValue(amountMinor: number): void {
    this.safely('order_value', () => this.orderValue.observe(amountMinor));
  }

  recordCartOperation(op: CartOperation): void {
    this.safely('cart_operation', () => this.cartOps.inc({ op }));
  }

  recordAuthEvent(event: string, outcome: 'success' | 'failure'): void {
    this.safely('auth_event', () => this.authEvents.inc({ event, outcome }));
  }

  recordCatalogCacheOperation(result: CacheResult): void {
    this.safely('catalog_cache_operation', () => this.catalogCacheOps.inc({ result }));
  }

  recordEventPublished(eventType: string, result: PublishResult): void {
    this.safely('event_published', () => this.eventsPublished.inc({ event_type: eventType, result }));
  }

  recordEventConsumed(eventType: string, result: ConsumeResult): void {
    this.safely('event_consumed', () => this.eventsConsumed.inc({ event_type: eventType, result }));
  }

  recordConsumeRetry(eventType: string): void {
    this.safely('consume_retry', () => this.consumeRetries.inc({ event_type: eventType }));
  }

  recordDeadLetter(eventType: string, reason: DeadLetterReason): void {
    this.safely('dead_letter', () => this.deadLetters.inc({ event_type: eventType, reason }));
  }

  recordSagaStep(step: SagaStep, outcome: 'success' | 'failed'): void {
    this.safely('saga_step', () => this.sagaSteps.inc({ step, outcome }));
  }

  recordCompensation(trigger: CompensationTrigger): void {
    this.safely('saga_compensation', () => this.compensations.inc({ trigger }));
  }

  recordReservationExpiry(): void {
    this.safely('reservation_expiry', () => this.reservationExpiries.inc());
  }

  recordMailSendFailure(kind: MailKind): void {
    this.safely('mail_send_failure', () => this.mailSendFailures.inc({ kind }));
  }

  recordRefundOwed(source: RefundOwedSource): void {
    this.safely('payment_refund_owed', () => this.refundsOwed.inc({ source }));
  }

  recordRetentionSweep(sweep: string, rows: number): void {
    // Recorded even at zero, so the series exists from the first tick: a label that only appears
    // once something was deleted cannot be alerted on for having stopped.
    this.safely('retention_rows_deleted', () => this.retentionRowsDeleted.inc({ sweep }, rows));
  }

  observeRetentionSweepDuration(sweep: string, seconds: number): void {
    this.safely('retention_sweep_duration', () => this.retentionSweepDuration.observe({ sweep }, seconds));
  }

  recordRetentionSweepFailure(sweep: string): void {
    this.safely('retention_sweep_failure', () => this.retentionSweepFailures.inc({ sweep }));
  }

  recordMediaBytesReclaimed(bytes: number): void {
    if (bytes <= 0) return; // A counter cannot take 0 usefully, and an unmeasured object reports null as 0.
    this.safely('media_bytes_reclaimed', () => this.mediaBytesReclaimed.inc(bytes));
  }

  observeCacheRebuild(seconds: number): void {
    this.safely('cache_rebuild', () => this.cacheRebuildDuration.observe(seconds));
  }

  setBreakerState(breaker: string, state: BreakerState): void {
    this.safely('breaker_state', () => this.breakerState.set({ breaker }, BREAKER_STATE_VALUES[state]));
  }

  recordBreakerTransition(breaker: string, to: BreakerState): void {
    this.safely('breaker_transition', () => this.breakerTransitions.inc({ breaker, to }));
  }

  recordBreakerCall(breaker: string, result: BreakerCallResult): void {
    this.safely('breaker_call', () => this.breakerCalls.inc({ breaker, result }));
  }

  recordRateLimitRejection(tier: string, route: string): void {
    this.safely('rate_limit_rejection', () => this.rateLimitRejections.inc({ tier, route }));
  }

  // Swallow-and-log: a telemetry error is logged (so it's not invisible) but never rethrown.
  private safely(op: string, fn: () => void): void {
    try {
      fn();
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      this.logger.warn({ context: LOG_CONTEXT, op, err }, 'metric record failed');
    }
  }
}
