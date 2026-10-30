import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import {
  CHECKOUT_INVARIANT_KINDS,
  evaluateCheckoutInvariants,
  type CheckoutInvariantKind,
  type PaymentStanding,
} from '../../domain/checkout-invariants';
import { CHECKOUT_SAGA_ENGINE, type CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../ports/order-inventory-participant.port';
import { ORDER_PAYMENT_PARTICIPANT, type OrderPaymentParticipantPort } from '../ports/order-payment-participant.port';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
  type SettledSagaOrder,
  type SettledSagaOrderCursor,
} from '../ports/order-repository.port';

const LOG_CONTEXT = 'RunCheckoutInvariants';

const NO_PAYMENT: PaymentStanding = {
  header: null,
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
};

export type CheckoutInvariantCounts = Record<CheckoutInvariantKind, number>;

export type CheckoutInvariantRun =
  | { result: 'ok' | 'violations'; checked: number; violations: CheckoutInvariantCounts }
  | { result: 'error'; checked: number; violations: null };

/**
 * Reads settled checkout orders against what both participants hold for them and reports what does
 * not add up. It never repairs anything: a violation is a page for a person.
 */
@Injectable()
export class RunCheckoutInvariantsUseCase {
  private readonly settings: CheckoutSagaConfig['invariant'];

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    @Inject(ORDER_INVENTORY_PARTICIPANT) private readonly inventory: OrderInventoryParticipantPort,
    @Inject(ORDER_PAYMENT_PARTICIPANT) private readonly payment: OrderPaymentParticipantPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.settings = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').invariant;
  }

  async execute(): Promise<CheckoutInvariantRun> {
    const violations = Object.fromEntries(CHECKOUT_INVARIANT_KINDS.map((kind) => [kind, 0])) as CheckoutInvariantCounts;
    let checked = 0;
    try {
      const window = this.window();
      let after: SettledSagaOrderCursor | null = null;
      let batch: SettledSagaOrder[];
      do {
        batch = await this.orderRepo.findTerminalSagaOrdersInWindow(window, after, this.settings.batchSize);
        checked += await this.check(batch, violations);
        const last = batch.at(-1);
        if (last) after = { id: last.id, finalizedAt: last.finalizedAt };
      } while (batch.length === this.settings.batchSize);
    } catch (error) {
      // A partial count would read as a drop in violations, so the gauges keep the last full run.
      this.metrics.recordInvariantCheck('error');
      this.logger.warn({ err: toError(error), checked }, 'checkout invariant check failed, gauges left as they were');
      return { result: 'error', checked, violations: null };
    }

    const result = Object.values(violations).some((count) => count > 0) ? 'violations' : 'ok';
    this.metrics.setCheckoutInvariantViolations(violations);
    this.metrics.recordInvariantCheck(result);
    return { result, checked, violations };
  }

  private window(): { from: Date; to: Date } {
    const { windowSec, settleSec, notBefore } = this.settings;
    const now = Date.now();
    return {
      from: new Date(Math.max(now - windowSec * 1000, notBefore?.getTime() ?? -Infinity)),
      to: new Date(now - settleSec * 1000),
    };
  }

  /** Returns how many orders it judged; one still running is its saga's business, not the checker's. */
  private async check(batch: SettledSagaOrder[], violations: CheckoutInvariantCounts): Promise<number> {
    if (batch.length === 0) return 0;
    const running = await this.engine.runningOrderIds(batch.map(({ id }) => id));
    const settled = batch.filter(({ id }) => !running.has(id));
    if (settled.length === 0) return 0;

    const ids = settled.map(({ id }) => id);
    const [stock, payment] = await Promise.all([this.inventory.statusOf(ids), this.payment.statusOf(ids)]);
    for (const order of settled) {
      const broken = evaluateCheckoutInvariants({
        status: order.status,
        stock: stock.get(order.id) ?? null,
        payment: payment.get(order.id) ?? NO_PAYMENT,
      });
      for (const kind of broken) {
        violations[kind] += 1;
        this.logger.error({ orderId: order.id, kind, status: order.status }, 'checkout invariant violated');
      }
    }
    return settled.length;
  }
}
