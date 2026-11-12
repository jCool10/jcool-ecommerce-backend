import { expect } from 'vitest';
import {
  type CheckoutInvariantKind,
  evaluateCheckoutInvariants,
  type PaymentStanding,
  type StockStanding,
} from '../../src/modules/order/domain/checkout-invariants';
import type { OrderStatus } from '../../src/modules/order/domain/order-status';
import { metricSum, type SagaRun } from './checkout-observers';
import { type CheckoutStack, waitFor } from './checkout-stack';

export interface ExpectedOrder {
  orderId: string;
  status: string;
  /** Saga runs the order went through; one unless the scenario says otherwise. */
  runs?: number;
  /** Refund runs the order went through; one for a refunded order, none otherwise, unless said. */
  refundRuns?: number;
  /** What the checker must report for this order, for a scenario that breaks an invariant on purpose. */
  violations?: CheckoutInvariantKind[];
}

/**
 * What must hold once a scenario has settled, read from each service's own database, the fake
 * Stripe and Temporal, then from the order-service's own checker.
 */
export async function expectCheckoutInvariants(stack: CheckoutStack, orders: ExpectedOrder[]): Promise<void> {
  for (const order of orders) await expectSettledOrder(stack, order);
  await expectStockBalanced(stack);
  await expectCheckerReports(
    stack,
    orders.flatMap((order) => order.violations ?? []),
  );
}

async function expectSettledOrder(stack: CheckoutStack, expected: ExpectedOrder): Promise<void> {
  const { orderId, status, runs = 1, violations = [] } = expected;
  const refundRuns = expected.refundRuns ?? (status === 'REFUNDED' ? 1 : 0);
  await stack.waitForOrderStatus(orderId, status, 15_000);
  // A run closes only after its compensations; before that the order is final and its stock and payment are not.
  await expectClosedRuns(() => stack.saga.runs(orderId), runs, `saga run(s) of ${orderId}`);
  await expectClosedRuns(() => stack.saga.refundRuns(orderId), refundRuns, `refund run(s) of ${orderId}`);

  const [row] = await stack.sql<{ status: OrderStatus; total: string }>(
    'orders',
    'select status, total_amount::text as total from orders where id = $1',
    [orderId],
  );
  expect(row?.status, `order ${orderId}`).toBe(status);

  const stock = ((await stack.inventoryHeader(orderId)) ?? null) as StockStanding;
  const payment = await paymentStanding(stack, orderId);
  expect(evaluateCheckoutInvariants({ status: row.status, stock, payment }), `order ${orderId}`).toEqual(violations);

  // A refunded order was charged too: a refund is a fact of its own, the intent stays succeeded.
  const charged = row.status === 'PAID' || row.status === 'REFUNDED';
  const { intents } = await stack.stripe.ofOrder(orderId);
  const stats = await stack.stripe.stats();
  for (const intent of intents) {
    expect(stats.byPi[intent.id]?.captures ?? 0, `captures of ${intent.id}`).toBeLessThanOrEqual(1);
    expect(intent.status, `intent ${intent.id} of a settled order`).not.toBe('requires_capture');
    expect(stats.byPi[intent.id]?.refundedAmount ?? 0, `refunded on ${intent.id}`).toBeLessThanOrEqual(
      intent.amount_received,
    );
  }
  const succeeded = intents.filter((intent) => intent.status === 'succeeded');
  expect(succeeded.length, `succeeded intents of ${orderId}`).toBe(charged ? 1 : 0);
  if (charged) expect(succeeded[0].amount_received).toBe(Number(row.total));
  await expectRefundMatchesStripe(stack, orderId, payment.header, succeeded[0]?.id, Number(row.total));
}

async function expectClosedRuns(list: () => Promise<SagaRun[]>, count: number, what: string): Promise<void> {
  const closed = await waitFor(
    list,
    (all) => all.length === count && all.every((run) => run.status !== 'RUNNING'),
    15_000,
    `${count} closed ${what}`,
  );
  expect(closed.map((run) => run.status)).toEqual(Array(count).fill('COMPLETED'));
}

/**
 * The payment-service's refund row against what Stripe holds: a refunded header means the whole
 * charge went back, a failed one that some of it is still owed.
 */
async function expectRefundMatchesStripe(
  stack: CheckoutStack,
  orderId: string,
  header: PaymentStanding['header'],
  intentId: string | undefined,
  total: number,
): Promise<void> {
  const refund = await stack.paymentRefund(orderId);
  const refunded = intentId ? ((await stack.stripe.intentStats(intentId))?.refundedAmount ?? 0) : 0;
  if (header === 'REFUNDED') {
    expect(refund?.status, `refund row of ${orderId}`).toBe('SUCCEEDED');
    expect(refunded, `refunded on the charge of ${orderId}`).toBe(total);
  } else if (header === 'REFUND_FAILED') {
    expect(refund?.status, `refund row of ${orderId}`).toBe('FAILED');
    expect(refunded, `refunded on the charge of ${orderId}`).toBeLessThan(total);
  } else {
    expect(refund, `refund row of ${orderId} under ${header}`).toBeUndefined();
  }
}

// The query behind the payment-service's statusOf, so the snapshot is what the checker would be told.
async function paymentStanding(stack: CheckoutStack, orderId: string): Promise<PaymentStanding> {
  const [row] = await stack.sql<{
    header: PaymentStanding['header'];
    authorized_payment_id: string | null;
    has_authorized_attempt: boolean;
    has_succeeded_attempt: boolean;
  }>(
    'payment',
    `select po.status as header,
       (select p.id::text from payments p where p.order_id = $1 and p.status in ('AUTHORIZED', 'SUCCEEDED') limit 1)
         as authorized_payment_id,
       exists (select 1 from payments p where p.order_id = $1 and p.status = 'AUTHORIZED') as has_authorized_attempt,
       exists (select 1 from payments p where p.order_id = $1 and p.status = 'SUCCEEDED') as has_succeeded_attempt
     from (select $1::bigint as order_id) ids
     left join payment_orders po on po.order_id = ids.order_id`,
    [orderId],
  );
  return {
    header: row.header,
    authorizedPaymentId: row.authorized_payment_id,
    hasAuthorizedAttempt: row.has_authorized_attempt,
    hasSucceededAttempt: row.has_succeeded_attempt,
  };
}

async function expectStockBalanced(stack: CheckoutStack): Promise<void> {
  const unbalanced = await stack.sql(
    'inventory',
    `select s.variant_id::text, s.quantity_on_hand, s.quantity_reserved, coalesce(h.held, 0)::int as held
     from stock_levels s
     left join (select variant_id, sum(quantity) as held from reservations where status = 'HELD' group by variant_id) h
       on h.variant_id = s.variant_id
     where s.quantity_on_hand < 0 or s.quantity_reserved <> coalesce(h.held, 0)`,
  );
  expect(unbalanced, 'stock levels against their HELD reservations').toEqual([]);
}

// One full checker pass that started after the scenario settled, then it reports exactly what is expected.
async function expectCheckerReports(stack: CheckoutStack, expected: CheckoutInvariantKind[]): Promise<void> {
  const passes = async () =>
    metricSum(
      await stack.scrapeOrderMetrics(),
      'checkout_invariant_check_total',
      (labels) => labels.result !== 'error',
    );
  const before = await passes();
  await waitFor(passes, (count) => count >= before + 2, 10_000, 'two more checker passes');

  const reported = Object.fromEntries(
    (await stack.scrapeOrderMetrics())
      .filter((sample) => sample.name === 'checkout_invariant_violations' && sample.value !== 0)
      .map((sample) => [sample.labels.kind, sample.value]),
  );
  const counts: Record<string, number> = {};
  for (const kind of expected) counts[kind] = (counts[kind] ?? 0) + 1;
  expect(reported, 'checkout_invariant_violations').toEqual(counts);
}
