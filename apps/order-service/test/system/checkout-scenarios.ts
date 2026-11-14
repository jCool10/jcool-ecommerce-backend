import { metricSum } from './checkout-observers';
import { type Buyer, type CheckoutStack, expectStatus, waitFor } from './checkout-stack';

export const ORDER_MAIL_SUBJECT = 'Your order is confirmed';
export const REFUND_MAIL_SUBJECT = 'Your refund has been issued';

export interface PaidOrder {
  buyer: Buyer;
  orderId: string;
  sessionId: string;
  intentId: string;
  skuId: string;
  /** What Stripe captured, in minor units. */
  amount: number;
}

/**
 * The steps and reads the system scenarios share. `stack` is read on every call, since a spec assigns
 * it in `beforeAll`.
 */
export function checkoutScenarios(stack: () => CheckoutStack) {
  async function placeOrder(buyer?: Buyer) {
    const owner = buyer ?? (await stack().buyer());
    const placed = expectStatus(await stack().checkout(owner), 201);
    return { buyer: owner, orderId: placed.body.id as string };
  }

  async function awaitingAuthorization(buyer?: Buyer) {
    const order = await placeOrder(buyer);
    const session = expectStatus(await stack().pay(order.buyer, order.orderId), 201);
    return { ...order, sessionId: session.body.providerSessionId };
  }

  /** Authorized through the webhook and captured by the saga, the confirmation mail included. */
  async function paidOrder(skuId = stack().skus[0]): Promise<PaidOrder> {
    const { buyer, orderId, sessionId } = await awaitingAuthorization(await stack().buyer(skuId));
    const { body } = await stack().authorize(sessionId, { deliverWebhook: true });
    if (body.webhook?.status !== 200) throw new Error(`webhook of ${orderId}: ${JSON.stringify(body.webhook)}`);
    await stack().waitForOrderStatus(orderId, 'PAID', 15_000);
    const [{ total }] = await stack().sql<{ total: string }>(
      'orders',
      'select total_amount::text as total from orders where id = $1',
      [orderId],
    );
    return { buyer, orderId, sessionId, intentId: body.intentId, skuId, amount: Number(total) };
  }

  async function outboxIds(db: 'payment' | 'orders', eventType: string, orderId: string): Promise<string[]> {
    const rows = await stack().sql<{ id: string }>(
      db,
      `select id::text from outbox where event_type = $1 and payload->>'orderId' = $2`,
      [eventType, orderId],
    );
    return rows.map((row) => row.id);
  }

  async function paymentRow(orderId: string): Promise<{ status: string; stripe_key_gen: number }> {
    const [row] = await stack().sql<{ status: string; stripe_key_gen: number }>(
      'payment',
      'select status, stripe_key_gen from payments where order_id = $1 order by id desc limit 1',
      [orderId],
    );
    return row;
  }

  async function onHand(skuId: string): Promise<number> {
    const [row] = await stack().sql<{ on_hand: number }>(
      'inventory',
      'select quantity_on_hand as on_hand from stock_levels where variant_id = $1',
      [skuId],
    );
    return row.on_hand;
  }

  async function reserved(skuId: string): Promise<number> {
    const [row] = await stack().sql<{ reserved: number }>(
      'inventory',
      'select quantity_reserved as reserved from stock_levels where variant_id = $1',
      [skuId],
    );
    return row.reserved;
  }

  async function breakerState(breaker: string): Promise<number> {
    return metricSum(
      await stack().scrapeOrderMetrics(),
      'circuit_breaker_state',
      (labels) => labels.breaker === breaker,
    );
  }

  async function refundMails(email: string) {
    return (await stack().mailsTo(email)).filter((mail) => mail.Subject === REFUND_MAIL_SUBJECT);
  }

  /** Until the buyer's refund mail lands, then exactly one of it. */
  async function expectOneRefundMail(email: string, timeoutMs = 15_000): Promise<void> {
    const mails = await waitFor(
      () => refundMails(email),
      (found) => found.length >= 1,
      timeoutMs,
      'refund mail',
    );
    if (mails.length !== 1) throw new Error(`${mails.length} refund mails to ${email}`);
  }

  return {
    placeOrder,
    awaitingAuthorization,
    paidOrder,
    outboxIds,
    paymentRow,
    onHand,
    reserved,
    breakerState,
    refundMails,
    expectOneRefundMail,
  };
}
