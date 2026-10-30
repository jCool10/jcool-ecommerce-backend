import { expect } from 'vitest';
import {
  evaluateCheckoutInvariants,
  type PaymentStanding,
  type StockStanding,
} from '../../src/modules/order/domain/checkout-invariants';
import type { OrderStatus } from '../../src/modules/order/domain/order-status';
import { metricSum } from './checkout-observers';
import { type CheckoutStack, waitFor } from './checkout-stack';

export interface ExpectedOrder {
  orderId: string;
  status: string;
  /** Saga runs the order went through; one unless the scenario says otherwise. */
  runs?: number;
}

/**
 * What must hold once a scenario has settled, read from each service's own database, the fake
 * Stripe and Temporal, then from the order-service's own checker.
 */
export async function expectCheckoutInvariants(stack: CheckoutStack, orders: ExpectedOrder[]): Promise<void> {
  for (const order of orders) await expectSettledOrder(stack, order);
  await expectStockBalanced(stack);
  await expectCheckerClean(stack);
}

async function expectSettledOrder(stack: CheckoutStack, { orderId, status, runs = 1 }: ExpectedOrder): Promise<void> {
  await stack.waitForOrderStatus(orderId, status, 15_000);
  // A run closes only after its compensations; before that the order is final and its stock and payment are not.
  const closed = await waitFor(
    () => stack.saga.runs(orderId),
    (all) => all.length === runs && all.every((run) => run.status !== 'RUNNING'),
    15_000,
    `${runs} closed saga run(s) of ${orderId}`,
  );
  expect(closed.map((run) => run.status)).toEqual(Array(runs).fill('COMPLETED'));

  const [row] = await stack.sql<{ status: OrderStatus; total: string }>(
    'orders',
    'select status, total_amount::text as total from orders where id = $1',
    [orderId],
  );
  expect(row?.status, `order ${orderId}`).toBe(status);

  const stock = ((await stack.inventoryHeader(orderId)) ?? null) as StockStanding;
  const payment = await paymentStanding(stack, orderId);
  expect(evaluateCheckoutInvariants({ status: row.status, stock, payment }), `order ${orderId}`).toEqual([]);

  const paid = row.status === 'PAID';
  const { intents } = await stack.stripe.ofOrder(orderId);
  const stats = await stack.stripe.stats();
  for (const intent of intents) {
    expect(stats.byPi[intent.id]?.captures ?? 0, `captures of ${intent.id}`).toBeLessThanOrEqual(1);
    expect(intent.status, `intent ${intent.id} of a settled order`).not.toBe('requires_capture');
  }
  const succeeded = intents.filter((intent) => intent.status === 'succeeded');
  expect(succeeded.length, `succeeded intents of ${orderId}`).toBe(paid ? 1 : 0);
  if (paid) expect(succeeded[0].amount_received).toBe(Number(row.total));
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

// One full checker pass that started after the scenario settled, then nothing it has seen is broken.
async function expectCheckerClean(stack: CheckoutStack): Promise<void> {
  const passes = async () =>
    metricSum(
      await stack.scrapeOrderMetrics(),
      'checkout_invariant_check_total',
      (labels) => labels.result !== 'error',
    );
  const before = await passes();
  await waitFor(passes, (count) => count >= before + 2, 10_000, 'two more checker passes');

  const violations = (await stack.scrapeOrderMetrics()).filter(
    (sample) => sample.name === 'checkout_invariant_violations' && sample.value !== 0,
  );
  expect(violations, 'checkout_invariant_violations').toEqual([]);
}
