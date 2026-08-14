import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Counter, Histogram } from 'prom-client';
import type { CartOperation, MetricsPort } from './metrics.port';
import {
  AUTH_EVENTS_TOTAL,
  CART_OPERATIONS_TOTAL,
  ORDERS_CREATED_TOTAL,
  ORDER_VALUE_MINOR,
} from './metric-definitions';

const LOG_CONTEXT = 'BusinessMetrics';

/**
 * prom-client implementation of MetricsPort. Every record is fire-and-forget: wrapped in
 * `safely()` so a metric can never break the business flow (ADR-0014 principle — telemetry
 * failure must not fail the request). prom-client's inc/observe don't throw for the bounded
 * labels used here, but the guard makes that structural rather than a caller assumption —
 * e.g. `order.service.place()` records AFTER the order is persisted. Injected as `METRICS`.
 */
@Injectable()
export class BusinessMetrics implements MetricsPort {
  constructor(
    @InjectMetric(ORDERS_CREATED_TOTAL) private readonly ordersCreated: Counter<string>,
    @InjectMetric(ORDER_VALUE_MINOR) private readonly orderValue: Histogram<string>,
    @InjectMetric(CART_OPERATIONS_TOTAL) private readonly cartOps: Counter<string>,
    @InjectMetric(AUTH_EVENTS_TOTAL) private readonly authEvents: Counter<string>,
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
