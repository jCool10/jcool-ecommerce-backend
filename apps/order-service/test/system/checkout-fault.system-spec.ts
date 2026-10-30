import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { metricSum } from './checkout-observers';
import { ORDER_PAID_CONSUMER_ATTEMPTS, SAGA_TIMINGS } from './checkout-stack-env';
import { expectCheckoutInvariants } from './checkout-invariants';
import { type Buyer, CheckoutStack, expectStatus, type HttpResult, waitFor } from './checkout-stack';

const ORDER_MAIL_SUBJECT = 'Your order is confirmed';
const SEEDED_ON_HAND = 1_000_000_000;
// A restarted service is ready before this, and the saga has resumed by then.
const AFTER_RESTART_MS = 20_000;
const CONVERGE_MS = 30_000;
// BullMQ hands a dead worker's job back once its 30s lock lapses and a 30s stalled check finds it.
const STALLED_MS = 75_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('checkout across every service, under real faults', () => {
  let stack: CheckoutStack;

  beforeAll(async () => {
    stack = await CheckoutStack.start();
  });

  afterAll(() => stack?.stop());

  afterEach(() => stack.restore());

  // --- scenario helpers ------------------------------------------------------------------------

  async function placeOrder(buyer?: Buyer) {
    const owner = buyer ?? (await stack.buyer());
    const placed = expectStatus(await stack.checkout(owner), 201);
    return { buyer: owner, orderId: placed.body.id as string };
  }

  async function awaitingAuthorization() {
    const order = await placeOrder();
    const session = expectStatus(await stack.pay(order.buyer, order.orderId), 201);
    return { ...order, sessionId: session.body.providerSessionId };
  }

  async function ordersOf(buyer: Buyer): Promise<{ id: string; status: string }[]> {
    return stack.sql('orders', 'select id::text, status from orders where user_id = $1 order by id', [buyer.userId]);
  }

  /** Until the saga expires the order, from its deadline in the database. */
  async function msUntilExpiry(orderId: string): Promise<number> {
    const [{ deadline }] = await stack.sql<{ deadline: string }>(
      'orders',
      'select (extract(epoch from payment_deadline_at) * 1000)::bigint::text as deadline from orders where id = $1',
      [orderId],
    );
    return Number(deadline) + SAGA_TIMINGS.authGraceSec * 1000 - Date.now();
  }

  async function outboxIds(db: 'payment' | 'orders', eventType: string, orderId: string): Promise<string[]> {
    const rows = await stack.sql<{ id: string }>(
      db,
      `select id::text from outbox where event_type = $1 and payload->>'orderId' = $2`,
      [eventType, orderId],
    );
    return rows.map((row) => row.id);
  }

  async function inboxClaims(messageId: string): Promise<number> {
    const [{ count }] = await stack.sql<{ count: number }>(
      'orders',
      `select count(*)::int as count from inbox where consumer = 'order-events' and message_id = $1`,
      [messageId],
    );
    return count;
  }

  async function webhookEvents(sessionId: string): Promise<{ status: string }[]> {
    return stack.sql('payment', `select status from webhook_events where payload->'data'->'object'->>'id' = $1`, [
      sessionId,
    ]);
  }

  async function paymentRow(orderId: string): Promise<{ status: string; stripe_key_gen: number }> {
    const [row] = await stack.sql<{ status: string; stripe_key_gen: number }>(
      'payment',
      'select status, stripe_key_gen from payments where order_id = $1 order by id desc limit 1',
      [orderId],
    );
    return row;
  }

  async function onHand(skuId: string): Promise<number> {
    const [row] = await stack.sql<{ on_hand: number }>(
      'inventory',
      'select quantity_on_hand as on_hand from stock_levels where variant_id = $1',
      [skuId],
    );
    return row.on_hand;
  }

  async function reserved(skuId: string): Promise<number> {
    const [row] = await stack.sql<{ reserved: number }>(
      'inventory',
      'select quantity_reserved as reserved from stock_levels where variant_id = $1',
      [skuId],
    );
    return row.reserved;
  }

  async function breakerState(breaker: string): Promise<number> {
    return metricSum(await stack.scrapeOrderMetrics(), 'circuit_breaker_state', (labels) => labels.breaker === breaker);
  }

  async function compensations(kind?: string): Promise<number> {
    return metricSum(
      await stack.scrapeOrderMetrics(),
      'saga_compensation_total',
      (labels) => kind === undefined || labels.kind === kind,
    );
  }

  const intentStats = (intentId: string) => stack.stripe.intentStats(intentId);
  const faultsFired = () => stack.stripe.faultsFired();
  const keySuffixes = (keys: string[]) => keys.map((key) => key.slice(key.lastIndexOf(':')));

  const expectRetryLater = (res: HttpResult) => {
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
  };

  // --- the happy path --------------------------------------------------------------------------

  it('takes a cart to a paid order, with its mail, through every service', async () => {
    const { buyer, orderId, sessionId } = await awaitingAuthorization();

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    expect(body.webhook?.status).toBe(200);
    await stack.waitForOrderStatus(orderId, 'PAID', 10_000);

    expect(await stack.inventoryHeader(orderId)).toBe('COMMITTED');
    expect(await stack.paymentHeader(orderId)).toBe('CAPTURED');
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await waitFor(
      () => stack.mailsTo(buyer.email),
      (mails) => mails.some((mail) => mail.Subject === ORDER_MAIL_SUBJECT),
      10_000,
      'order mail',
    );
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- stock ------------------------------------------------------------------------------------

  it('sells the last unit to exactly one of twenty buyers racing for it', async () => {
    const sku = stack.skus[stack.skus.length - 1];
    const scarce = await stack.sql(
      'inventory',
      'update stock_levels set quantity_on_hand = 1 where variant_id = $1 and quantity_reserved = 0 returning id',
      [sku],
    );
    expect(scarce).toHaveLength(1);
    try {
      const buyers = await Promise.all(Array.from({ length: 20 }, () => stack.buyer(sku)));

      const results = await Promise.all(buyers.map((buyer) => stack.checkout(buyer)));

      const statuses = results.map((res) => res.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(19);
      const winner = statuses.indexOf(201);
      const winnerId = results[winner].body.id as string;
      const losers = (await Promise.all(buyers.map(ordersOf))).flat().filter((order) => order.id !== winnerId);
      expect(losers).toHaveLength(19);
      const loserIds = losers.map((order) => order.id);
      // A refused Try leaves nothing, then the saga fences it so no late Try can hold either.
      expect(
        await stack.sql('inventory', 'select order_id::text from reservations where order_id = any($1::bigint[])', [
          loserIds,
        ]),
      ).toEqual([]);
      await waitFor(
        () =>
          stack.sql<{ status: string }>(
            'inventory',
            'select status from reservation_orders where order_id = any($1::bigint[])',
            [loserIds],
          ),
        (headers) => headers.length === loserIds.length && headers.every((header) => header.status === 'FENCED'),
        CONVERGE_MS,
        'every loser fenced',
      );

      expectStatus(await stack.cancel(buyers[winner], winnerId), 200);
      expect({ onHand: await onHand(sku), reserved: await reserved(sku) }).toEqual({ onHand: 1, reserved: 0 });
      await expectCheckoutInvariants(stack, [
        { orderId: winnerId, status: 'CANCELLED' },
        ...loserIds.map((orderId) => ({ orderId, status: 'REJECTED' })),
      ]);
    } finally {
      await stack.sql('inventory', 'update stock_levels set quantity_on_hand = $2 where variant_id = $1', [
        sku,
        SEEDED_ON_HAND,
      ]);
    }
  });

  it('fences a Try that timed out, so the late one is refused and the same key places a new order', async () => {
    const sku = stack.skus[0];
    const baseline = await reserved(sku);
    const buyer = await stack.buyer(sku);
    const key = randomUUID();
    await stack.addToxic('order-to-inventory', { type: 'timeout', stream: 'upstream', attributes: { timeout: 0 } });

    expectRetryLater(await stack.checkout(buyer, key));
    await stack.clearToxics();

    const [rejected] = await ordersOf(buyer);
    await stack.waitForOrderStatus(rejected.id, 'REJECTED', CONVERGE_MS);
    await stack.waitForInventoryHeader(rejected.id, 'FENCED');
    const late = await stack.direct('inventory-service', 'POST', `/internal/v1/reservations/${rejected.id}/try`, {
      token: stack.secrets.orderToInventory,
      body: { lines: [{ variantId: sku, quantity: 1 }], holdUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ outcome: 'CONFLICT' });
    expect(await reserved(sku)).toBe(baseline);

    await waitFor(
      () => breakerState('inventory-service'),
      (state) => state === 0,
      CONVERGE_MS,
      'breaker closed',
    );
    const retried = await waitFor(
      () => stack.checkout(buyer, key),
      (res) => res.status !== 503,
      CONVERGE_MS,
      'checkout retried under the same key',
    );
    expectStatus(retried, 201);
    expect(retried.body.id).not.toBe(rejected.id);
    expectStatus(await stack.cancel(buyer, retried.body.id), 200);
    await expectCheckoutInvariants(stack, [
      { orderId: rejected.id, status: 'REJECTED' },
      { orderId: retried.body.id, status: 'CANCELLED' },
    ]);
  });

  // --- the order-service killed at each step ---------------------------------------------------

  it('releases the stock of a Try whose worker was killed while it was in flight', async () => {
    const buyer = await stack.buyer();
    await stack.addToxic('order-to-inventory', { type: 'latency', stream: 'downstream', attributes: { latency: 800 } });

    const checkout = stack.checkout(buyer);
    const [order] = await waitFor(
      () => ordersOf(buyer),
      (orders) => orders.length === 1,
      10_000,
      'order row',
    );
    await stack.waitForInventoryHeader(order.id, 'HELD', 5_000);
    await stack.killService('order-service');

    expect([502, 503]).toContain((await checkout).status);
    await stack.clearToxics();
    await stack.startService('order-service');
    await stack.waitForOrderStatus(order.id, 'REJECTED', AFTER_RESTART_MS);
    await stack.waitForInventoryHeader(order.id, 'RELEASED', 5_000);
    expect(await compensations('release_stock')).toBeGreaterThanOrEqual(1);
    await expectCheckoutInvariants(stack, [{ orderId: order.id, status: 'REJECTED' }]);
  });

  it('expires an order whose worker was killed while it waited for an authorization', async () => {
    const { orderId } = await awaitingAuthorization();

    await stack.killService('order-service');
    await stack.startService('order-service');

    await stack.waitForOrderStatus(orderId, 'EXPIRED', (await msUntilExpiry(orderId)) + 5_000);
    // The saga closes the order before it compensates; the attempt turns EXPIRED once Stripe's session has.
    await waitFor(
      () => paymentRow(orderId),
      (row) => row.status === 'EXPIRED',
      CONVERGE_MS,
      'session expired',
    );
    await stack.waitForInventoryHeader(orderId, 'RELEASED');
    expect((await stack.stripe.stats()).sessionsExpired).toBe(1);
    expect(await stack.paymentHeader(orderId)).toBe('CANCELLED');
    await expectCheckoutInvariants(stack, [{ orderId, status: 'EXPIRED' }]);
  });

  it('completes an order authorized while its worker was dead, once it is back', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.killService('order-service');

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    expect(body.webhook?.status).toBe(200);
    await stack.startService('order-service');

    await stack.waitForOrderStatus(orderId, 'PAID', await msUntilExpiry(orderId));
    const [event] = await outboxIds('payment', 'payment.authorized', orderId);
    expect(await inboxClaims(event)).toBe(1);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('retries a stock commit that was applied before its worker was killed, and applies it once', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    const sku = stack.skus[0];
    const before = await onHand(sku);
    await stack.addToxic('order-to-inventory', {
      type: 'latency',
      stream: 'downstream',
      attributes: { latency: SAGA_TIMINGS.inventoryCommandTimeoutMs - 1_500 },
    });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForInventoryHeader(orderId, 'COMMITTED', 15_000);
    await stack.killService('order-service');
    await stack.clearToxics();
    await stack.startService('order-service');

    await stack.waitForOrderStatus(orderId, 'PAID', SAGA_TIMINGS.activityTimeoutMs + SAGA_TIMINGS.retryBaseMs + 5_000);
    expect(await stack.saga.activityRuns(orderId)).toContainEqual({
      activity: 'commitStock',
      attempt: 2,
      lastTimeout: 'START_TO_CLOSE',
    });
    expect(await onHand(sku)).toBe(before - 1);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('finishes an order whose capture went through before its worker was killed, compensating nothing', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.addToxic('order-to-payment', {
      type: 'latency',
      stream: 'downstream',
      // The verify call before the capture sits behind the same delay, so it needs the margin too.
      attributes: { latency: SAGA_TIMINGS.paymentCommandTimeoutMs - 1_500 },
    });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await waitFor(
      () => intentStats(body.intentId),
      (stats) => stats?.captures === 1,
      CONVERGE_MS,
      'capture applied',
    );
    await stack.killService('order-service');
    await stack.clearToxics();
    await stack.startService('order-service');

    await stack.waitForOrderStatus(orderId, 'PAID', SAGA_TIMINGS.activityTimeoutMs + SAGA_TIMINGS.retryBaseMs + 5_000);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    expect(await compensations()).toBe(0);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('mails a paid order at most once when its worker is killed while sending the mail', async () => {
    const { buyer, orderId, sessionId } = await awaitingAuthorization();
    // The mail server's answers held back, so the send is still open when the worker dies.
    await stack.addToxic('order-to-smtp', { type: 'latency', stream: 'downstream', attributes: { latency: 5_000 } });

    await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForOrderStatus(orderId, 'PAID', 15_000);
    const [paid] = await waitFor(
      () =>
        stack.sql<{ id: string }>(
          'orders',
          `select id::text from outbox where event_type = 'order.paid' and aggregate_id = $1`,
          [orderId],
        ),
      (rows) => rows.length === 1,
      CONVERGE_MS,
      'order.paid written',
    );
    // The claim commits before the send starts.
    await waitFor(
      () => inboxClaims(paid.id),
      (claims) => claims === 1,
      CONVERGE_MS,
      'order.paid claimed',
    );
    await stack.killService('order-service');
    await stack.clearToxics();
    await stack.startService('order-service');

    const [job] = await waitFor(
      async () => (await stack.queueJobs('order-events', 'order.paid')).filter((j) => j.data.outboxId === paid.id),
      (jobs) => jobs[0]?.finishedOn !== undefined,
      STALLED_MS,
      'order.paid handed back and finished',
    );
    expect(job.failedReason).toBeUndefined();
    expect(await inboxClaims(paid.id)).toBe(1);
    // Lost rather than sent twice: the redelivery finds the claim and sends nothing.
    const mails = (await stack.mailsTo(buyer.email)).filter((mail) => mail.Subject === ORDER_MAIL_SUBJECT);
    expect(mails).toEqual([]);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- the payment-service killed --------------------------------------------------------------

  it('keeps an authorization whose webhook was answered just before the payment-service was killed', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    expect(body.webhook?.status).toBe(200);
    await stack.killService('payment-service');
    await stack.startService('payment-service');

    await stack.waitForOrderStatus(orderId, 'PAID', AFTER_RESTART_MS);
    expect(await webhookEvents(sessionId)).toHaveLength(1);
    expect(await outboxIds('payment', 'payment.authorized', orderId)).toHaveLength(1);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('replays a capture that landed while the payment-service was being killed', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: 'slow', target: 'capture', ms: 600 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await waitFor(
      () => intentStats(body.intentId),
      (s) => s?.capturesInFlight === 1,
      CONVERGE_MS,
      'capture in flight',
    );
    await stack.killService('payment-service');
    await stack.startService('payment-service');

    await stack.waitForOrderStatus(orderId, 'PAID', AFTER_RESTART_MS);
    const stats = await intentStats(body.intentId);
    expect(await faultsFired()).toEqual({ 'slow:capture': 1 });
    expect(stats.captures).toBe(1);
    expect(stats.replays).toBeGreaterThanOrEqual(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- Stripe misbehaving ----------------------------------------------------------------------

  it('retries a capture Stripe never answered under the same key', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: 'hang', target: 'capture', times: 2, ms: 3_000 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);

    const stats = await intentStats(body.intentId);
    expect(await faultsFired()).toEqual({ 'hang:capture': 2 });
    expect(keySuffixes(stats.keys)).toEqual([':0']);
    expect(stats.captureRequests).toBeGreaterThanOrEqual(3);
    expect(stats.captures).toBe(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('moves to a new key after each 500 Stripe stored under the old one', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: '500', target: 'capture', times: 2 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);

    expect((await paymentRow(orderId)).stripe_key_gen).toBe(2);
    const stats = await intentStats(body.intentId);
    expect(await faultsFired()).toEqual({ '500:capture': 2 });
    expect(keySuffixes(stats.keys)).toEqual([':0', ':1', ':2']);
    expect(stats.captures).toBe(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('takes a capture Stripe applied before answering 500 as done, without a new key', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: 'apply_then_500', target: 'capture', times: 1 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);

    const stats = await intentStats(body.intentId);
    expect(await faultsFired()).toEqual({ 'apply_then_500:capture': 1 });
    expect(keySuffixes(stats.keys)).toEqual([':0']);
    expect(stats.captures).toBe(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- late and duplicate webhooks -------------------------------------------------------------

  it('voids an authorization whose webhook only arrives after the order expired', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    // Past the window to open a session, well before the deadline.
    const sincePlaced =
      (SAGA_TIMINGS.paymentDeadlineSec + SAGA_TIMINGS.authGraceSec) * 1000 - (await msUntilExpiry(orderId));
    await sleep(Math.max(0, 16_000 - sincePlaced));

    const { body } = await stack.authorize(sessionId, { deliverWebhook: false });
    await stack.waitForOrderStatus(orderId, 'EXPIRED', (await msUntilExpiry(orderId)) + 10_000);
    // The saga closes the order before it compensates, and this webhook is meant to come after both.
    await waitFor(
      () => paymentRow(orderId),
      (row) => row.status === 'VOIDED',
      CONVERGE_MS,
      'hold voided',
    );
    await stack.waitForInventoryHeader(orderId, 'RELEASED');
    expect((await stack.deliverWebhook(sessionId)).status).toBe(200);

    await waitFor(
      () => webhookEvents(sessionId),
      (rows) => rows[0]?.status === 'SKIPPED',
      10_000,
      'webhook skipped',
    );
    expect(await stack.paymentHeader(orderId)).toBe('CANCELLED');
    expect((await paymentRow(orderId)).status).toBe('VOIDED');
    expect(await intentStats(body.intentId)).toMatchObject({ voids: 1, captures: 0 });
    expect(await outboxIds('payment', 'payment.authorized', orderId)).toEqual([]);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'EXPIRED' }]);
  });

  it('voids a hold whose webhook lands between the two halves of a cancel, without reviving the order', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    const { body } = await stack.authorize(sessionId, { deliverWebhook: false });
    // The cancel's expire call is where the webhook lands: after the header flipped, before the void is recorded.
    await stack.setStripeFault({ mode: 'webhook_first', target: 'expire' });

    await stack.waitForOrderStatus(orderId, 'EXPIRED', (await msUntilExpiry(orderId)) + 10_000);
    await waitFor(
      () => paymentRow(orderId),
      (row) => row.status === 'VOIDED',
      CONVERGE_MS,
      'hold voided',
    );
    expect(await faultsFired()).toEqual({ 'webhook_first:expire': 1 });
    expect(await webhookEvents(sessionId)).toEqual([{ status: 'PROCESSED' }]);

    // Recorded late under the cancelled header, once; the saga voids it, never captures it.
    const late = await outboxIds('payment', 'payment.authorized', orderId);
    expect(late).toHaveLength(1);
    await waitFor(
      () => inboxClaims(late[0]),
      (claims) => claims === 1,
      CONVERGE_MS,
      'late authorization consumed',
    );
    expect(await stack.paymentHeader(orderId)).toBe('CANCELLED');
    expect(await intentStats(body.intentId)).toMatchObject({ voids: 1, captures: 0 });
    expect(await stack.orderStatus(orderId)).toBe('EXPIRED');
    // A late authorization that finds the saga closed gets a run of its own, started before the claim.
    const latest = await stack.saga.latestRunId(orderId);
    const runs = await waitFor(
      () => stack.saga.runs(orderId),
      (all) => all.some((run) => run.runId === latest),
      CONVERGE_MS,
      'latest saga run listed',
    );
    expect(runs.length).toBeLessThanOrEqual(2);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'EXPIRED', runs: runs.length }]);
  });

  it('captures once for a webhook delivered five times', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    const { body } = await stack.authorize(sessionId, { deliverWebhook: false });

    const deliveries = await Promise.all(Array.from({ length: 5 }, () => stack.deliverWebhook(sessionId)));

    expect(deliveries.map((delivery) => delivery.status)).toEqual([200, 200, 200, 200, 200]);
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    expect(await outboxIds('payment', 'payment.authorized', orderId)).toHaveLength(1);
    expect(await webhookEvents(sessionId)).toHaveLength(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- the inventory-service down --------------------------------------------------------------

  it('answers 503 while the inventory-service is down, and opens its breaker', async () => {
    await stack.stopService('inventory-service');
    const refused: Buyer[] = [];
    let open = false;
    while (!open) {
      expect(refused.length, 'checkouts before the breaker opened').toBeLessThan(30);
      const buyer = await stack.buyer();
      expectRetryLater(await stack.checkout(buyer));
      refused.push(buyer);
      open = (await breakerState('inventory-service')) === 2;
    }

    await stack.startService('inventory-service');
    await waitFor(
      () => breakerState('inventory-service'),
      (state) => state === 0,
      CONVERGE_MS,
      'breaker closed',
    );
    const { buyer, orderId } = await placeOrder();

    const rejected = (await Promise.all(refused.map(ordersOf))).flat();
    for (const order of rejected) {
      await stack.waitForOrderStatus(order.id, 'REJECTED', CONVERGE_MS);
      // Toxiproxy refuses at once while the service is down, so no Try got there; anything but a
      // fence means a Try was sent again.
      await stack.waitForInventoryHeader(order.id, 'FENCED');
    }
    expectStatus(await stack.cancel(buyer, orderId), 200);
    await expectCheckoutInvariants(stack, [
      ...rejected.map((order) => ({ orderId: order.id, status: 'REJECTED' })),
      { orderId, status: 'CANCELLED' },
    ]);
  });

  it('commits once when the inventory-service is killed after applying the commit', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    // Dropped, not delayed: a latency toxic hands over the reply it holds the moment it is removed.
    await stack.addToxic('order-to-inventory', { type: 'timeout', stream: 'downstream', attributes: { timeout: 0 } });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForInventoryHeader(orderId, 'COMMITTED', 15_000);
    await stack.killService('inventory-service');
    await stack.clearToxics();
    await stack.startService('inventory-service');

    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);
    const commits = await stack.scrapeMetrics('inventory-service');
    expect(metricSum(commits, 'tcc_branch_total', (l) => l.op === 'commit' && l.outcome === 'idempotent')).toBe(1);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- the buyer cancelling --------------------------------------------------------------------

  it('cancels a pending order at the buyer’s request and gives its stock back', async () => {
    const { buyer, orderId } = await awaitingAuthorization();

    const cancelled = expectStatus(await stack.cancel(buyer, orderId), 200);

    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await stack.stripe.stats()).sessionsExpired).toBe(1);
    expect(await stack.inventoryHeader(orderId)).toBe('RELEASED');
    await expectCheckoutInvariants(stack, [{ orderId, status: 'CANCELLED' }]);
  });

  it('refuses a cancel once the payment is being taken, and still completes the order', async () => {
    const { buyer, orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: 'slow', target: 'capture', ms: 600 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await stack.waitForOrderStatus(orderId, 'CONFIRMING', 10_000);

    expect((await stack.cancel(buyer, orderId)).status).toBe(409);
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);
    expect(await intentStats(body.intentId)).toMatchObject({ captures: 1 });
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  it('turns a second capture of the same payment into a retryable error', async () => {
    const { orderId, sessionId } = await awaitingAuthorization();
    await stack.setStripeFault({ mode: 'slow', target: 'capture', ms: 600 });

    const { body } = await stack.authorize(sessionId, { deliverWebhook: true });
    await waitFor(
      () => intentStats(body.intentId),
      (s) => s?.capturesInFlight === 1,
      CONVERGE_MS,
      'capture in flight',
    );
    const overlapping = await stack.direct('payment-service', 'POST', `/internal/v1/payments/${orderId}/capture`, {
      token: stack.secrets.orderToPayment,
    });

    expect(overlapping.status).toBe(503);
    await stack.waitForOrderStatus(orderId, 'PAID', CONVERGE_MS);
    const stats = await intentStats(body.intentId);
    expect(stats.conflicts409).toBeGreaterThanOrEqual(1);
    expect(stats.captures).toBe(1);
    await expectCheckoutInvariants(stack, [{ orderId, status: 'PAID' }]);
  });

  // --- Temporal down ---------------------------------------------------------------------------

  it('answers 503 while Temporal is down and carries every order on once it is back', async () => {
    const authorized = await awaitingAuthorization();
    const toCancel = await placeOrder();
    const latecomer = await stack.buyer();

    await stack.stopService('temporal');
    const stoppedAt = Date.now();
    expect((await stack.authorize(authorized.sessionId, { deliverWebhook: true })).body.webhook?.status).toBe(200);

    let startedAt = Date.now();
    expectRetryLater(await stack.checkout(latecomer));
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    const [reserving] = await ordersOf(latecomer);
    expect(reserving.status).toBe('RESERVING');
    startedAt = Date.now();
    expectRetryLater(await stack.cancel(toCancel.buyer, toCancel.orderId));
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    expectStatus(await stack.public('GET', '/products'), 200);
    expectStatus(await stack.public('GET', '/cart', { token: toCancel.buyer.token }), 200);
    expect(metricSum(await stack.scrapeOrderMetrics(), 'checkout_saga_engine_up')).toBe(0);
    expect((await stack.direct('order-service', 'GET', '/health/ready')).status).toBe(503);
    expectStatus(await stack.direct('api', 'GET', '/health/ready'), 200);
    const [event] = await outboxIds('payment', 'payment.authorized', authorized.orderId);
    const [job] = await waitFor(
      async () =>
        (await stack.queueJobs('order-events', 'payment.authorized')).filter((j) => j.data.outboxId === event),
      (jobs) => jobs[0]?.attemptsMade >= 1,
      10_000,
      'payment.authorized retried',
    );
    expect(job).toMatchObject({ attempts: ORDER_PAID_CONSUMER_ATTEMPTS, backoff: { type: 'order-paid' } });
    expect(await stack.queueJobs('order-events-dlq', 'payment.authorized')).toEqual([]);
    expect(await inboxClaims(event)).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);

    await stack.startService('temporal');

    await stack.waitForSagaWorker();
    await stack.waitForOrderStatus(authorized.orderId, 'PAID', await msUntilExpiry(authorized.orderId));
    await stack.waitForOrderStatus(reserving.id, 'REJECTED', CONVERGE_MS);
    await stack.waitForInventoryHeader(reserving.id, 'FENCED');
    const cancelled = await waitFor(
      () => stack.cancel(toCancel.buyer, toCancel.orderId),
      (res) => res.status !== 503,
      CONVERGE_MS,
      'cancel once Temporal is back',
    );
    expect(cancelled.body.status).toBe('CANCELLED');
    await expectCheckoutInvariants(stack, [
      { orderId: authorized.orderId, status: 'PAID' },
      { orderId: reserving.id, status: 'REJECTED' },
      { orderId: toCancel.orderId, status: 'CANCELLED' },
    ]);
  });

  it('freezes and unfreezes checkout at the gateway while Temporal is down', async () => {
    const buyer = await stack.buyer();
    const key = randomUUID();
    await stack.stopService('temporal');

    await stack.recreateService('gateway', { CHECKOUT_WRITE_FREEZE: 'true' });
    for (const res of [
      await stack.checkout(buyer, key),
      await stack.public('POST', '/orders/1/pay', { token: buyer.token }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('120');
      expect(res.body).toBe('checkout is read-only during a migration');
    }
    expect(await ordersOf(buyer)).toEqual([]);
    expectStatus(await stack.public('GET', '/products'), 200);

    await stack.recreateService('gateway', { CHECKOUT_WRITE_FREEZE: 'false' });
    const unavailable = await stack.checkout(buyer, key);
    expectRetryLater(unavailable);
    expect(unavailable.body).not.toBe('checkout is read-only during a migration');
    expectStatus(await stack.public('GET', '/products'), 200);

    await stack.startService('temporal');
    // The checkout answers once the workflow poller is back; the cancel waits on the activity one.
    await stack.waitForSagaWorker();
    const placed = await waitFor(
      () => stack.checkout(buyer, key),
      (res) => res.status !== 503,
      CONVERGE_MS,
      'checkout once Temporal is back',
    );
    expectStatus(placed, 201);
    expectStatus(await stack.cancel(buyer, placed.body.id), 200);
    await expectCheckoutInvariants(
      stack,
      (await ordersOf(buyer)).map((order) => ({
        orderId: order.id,
        status: order.id === placed.body.id ? 'CANCELLED' : 'REJECTED',
      })),
    );
  });
});
