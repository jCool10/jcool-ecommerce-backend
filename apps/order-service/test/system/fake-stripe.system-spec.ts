import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_STRIPE_PORT, FakeStripeControl, startFakeStripe } from './fake-stripe';

const WEBHOOK_SECRET = `whsec_${randomBytes(16).toString('hex')}`;

// The real SDK against the fake, set up the way the payment-service sets up its capture calls.
describe('fake Stripe, seen through the Stripe SDK', () => {
  let network: StartedNetwork;
  let fake: StartedTestContainer;
  let control: FakeStripeControl;
  let stripe: Stripe;

  beforeAll(async () => {
    network = await new Network().start();
    fake = await startFakeStripe(network, {
      PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      WEBHOOK_URL: `http://127.0.0.1:${FAKE_STRIPE_PORT}/__control/webhook-sink`,
    });
    control = new FakeStripeControl(() => `http://${fake.getHost()}:${fake.getMappedPort(FAKE_STRIPE_PORT)}`);
    stripe = new Stripe(`sk_test_${randomBytes(12).toString('hex')}`, {
      ...control.apiAddress(),
      maxNetworkRetries: 0,
      timeout: 5_000,
    });
  });

  afterAll(async () => {
    await fake?.stop();
    await network?.stop();
  });

  beforeEach(() => control.reset());

  const openSession = () =>
    stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        { quantity: 1, price_data: { currency: 'vnd', unit_amount: 150_000, product_data: { name: 'Order 1' } } },
      ],
      success_url: 'https://shop.invalid/ok',
      metadata: { order_id: '1' },
      expires_at: Math.floor(Date.now() / 1000) + 300,
      payment_intent_data: { capture_method: 'manual' },
    });

  const authorized = async () => {
    const session = await openSession();
    const { body } = await control.authorize(session.id, { deliverWebhook: false });
    return { session, intentId: body.intentId };
  };

  const thrown = async (call: Promise<unknown>): Promise<Stripe.errors.StripeError> => {
    const error = await call.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Stripe.errors.StripeError);
    return error as Stripe.errors.StripeError;
  };

  it('opens a manual-capture session and holds the amount once authorized', async () => {
    const session = await openSession();
    expect(session).toMatchObject({ status: 'open', payment_status: 'unpaid', amount_total: 150_000, currency: 'vnd' });

    await control.authorize(session.id, { deliverWebhook: false });
    const read = await stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent'] });

    expect(read).toMatchObject({ status: 'complete', payment_status: 'unpaid' });
    expect(read.payment_intent).toMatchObject({ status: 'requires_capture', amount_capturable: 150_000 });
  });

  it('captures, and answers the same key again with the stored result', async () => {
    const { intentId } = await authorized();

    const first = await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' });
    const again = await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' });

    expect(first.status).toBe('succeeded');
    expect(again.status).toBe('succeeded');
    expect(again.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect(await control.intentStats(intentId)).toMatchObject({ captures: 1, captureRequests: 2, replays: 1 });
  });

  it('refuses a new key on a captured intent as an unexpected state', async () => {
    const { intentId } = await authorized();
    await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' });

    const error = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:1' }));

    expect(error).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect(error.code).toBe('payment_intent_unexpected_state');
  });

  it('refuses a request under a key whose first request is still running (409)', async () => {
    const { intentId } = await authorized();
    await control.setFault({ mode: 'slow', target: 'capture', ms: 1_500 });

    const first = stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' });
    await expect.poll(async () => (await control.intentStats(intentId)).capturesInFlight).toBe(1);
    const error = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' }));

    // The SDK classes every 409 as an API error; only the raw type says which conflict it was.
    expect(error.statusCode).toBe(409);
    expect(error.rawType).toBe('idempotency_error');
    expect((await first).status).toBe('succeeded');
    expect(await control.intentStats(intentId)).toMatchObject({ captures: 1, conflicts409: 1 });
  });

  it('keeps a 500 under its key, so only a new key gets through', async () => {
    const { intentId } = await authorized();
    await control.setFault({ mode: '500', target: 'capture' });

    const first = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' }));
    const replayed = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' }));
    const held = await stripe.paymentIntents.retrieve(intentId);
    const fresh = await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:1' });

    expect([first.statusCode, replayed.statusCode]).toEqual([500, 500]);
    expect(held.status).toBe('requires_capture');
    expect(fresh.status).toBe('succeeded');
    expect(await control.intentStats(intentId)).toMatchObject({
      captures: 1,
      replays: 1,
      keys: ['capture:1:0', 'capture:1:1'],
    });
  });

  it('can apply a capture and still answer 500, and keeps that 500 under its key', async () => {
    const { intentId } = await authorized();
    await control.setFault({ mode: 'apply_then_500', target: 'capture' });

    const first = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' }));
    const replayed = await thrown(stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: 'capture:1:0' }));
    const read = await stripe.paymentIntents.retrieve(intentId);

    expect([first.statusCode, replayed.statusCode]).toEqual([500, 500]);
    expect(read.status).toBe('succeeded');
    expect(await control.intentStats(intentId)).toMatchObject({ captures: 1, replays: 1 });
    expect(await control.faultsFired()).toEqual({ 'apply_then_500:capture': 1 });
  });

  it('delivers the session webhook while it holds a call under webhook_first', async () => {
    const { session } = await authorized();
    await control.setFault({ mode: 'webhook_first', target: 'expire' });

    await thrown(stripe.checkout.sessions.expire(session.id));

    expect(await control.webhookSink()).toHaveLength(1);
    expect(await control.faultsFired()).toEqual({ 'webhook_first:expire': 1 });
  });

  it('refuses to expire a completed session (400)', async () => {
    const { session } = await authorized();

    const error = await thrown(stripe.checkout.sessions.expire(session.id));

    expect(error).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect(error.statusCode).toBe(400);
  });

  it('signs its webhook so the Stripe SDK verifies it with the shared secret', async () => {
    const session = await openSession();

    const { body } = await control.authorize(session.id, { deliverWebhook: true });
    const [delivery] = await control.webhookSink();
    const event = stripe.webhooks.constructEvent(delivery.body, delivery.signature, WEBHOOK_SECRET);

    expect(body.webhook?.status).toBe(200);
    expect(event.type).toBe('checkout.session.completed');
    expect(event.data.object).toMatchObject({
      id: session.id,
      payment_intent: body.intentId,
      payment_status: 'unpaid',
    });
  });

  it('will not authorize a session that has expired (409)', async () => {
    const session = await openSession();
    await stripe.checkout.sessions.expire(session.id);

    const { status } = await control.authorize(session.id, { deliverWebhook: false });

    expect(status).toBe(409);
    expect((await control.stats()).sessionsExpired).toBe(1);
  });

  describe('refunds', () => {
    const CAPTURED = 150_000;

    const captured = async () => {
      const { intentId } = await authorized();
      await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: `capture:${intentId}:0` });
      return intentId;
    };

    // The payment-service's create call, field for field.
    const refund = (intentId: string, key: string, amount = CAPTURED) =>
      stripe.refunds.create(
        {
          payment_intent: intentId,
          amount,
          reason: 'requested_by_customer',
          metadata: { order_id: '1', requested_by: '7' },
        },
        { idempotencyKey: key },
      );

    it('refunds a captured intent, keeps the metadata as sent, and reads it back by id and by intent', async () => {
      const intentId = await captured();

      const created = await refund(intentId, 'refund:1:0');
      const read = await stripe.refunds.retrieve(created.id);
      const listed = await stripe.refunds.list({ payment_intent: intentId, limit: 100 });

      expect(created).toMatchObject({
        object: 'refund',
        status: 'succeeded',
        amount: CAPTURED,
        currency: 'vnd',
        payment_intent: intentId,
        metadata: { order_id: '1', requested_by: '7' },
      });
      expect(read).toEqual(created);
      expect(listed.data.map((r) => r.id)).toEqual([created.id]);
      expect(await control.intentStats(intentId)).toMatchObject({
        refundRequests: 1,
        refundsCreated: 1,
        refundedAmount: CAPTURED,
        refundKeys: ['refund:1:0'],
        refunds: [{ id: created.id, amount: CAPTURED, status: 'succeeded', metadata: created.metadata }],
      });
    });

    it('answers the same key again with the stored refund and creates nothing more', async () => {
      const intentId = await captured();

      const first = await refund(intentId, 'refund:1:0');
      const again = await refund(intentId, 'refund:1:0');

      expect(again.id).toBe(first.id);
      expect(again.lastResponse.headers['idempotent-replayed']).toBe('true');
      expect(await control.intentStats(intentId)).toMatchObject({ refundRequests: 2, refundsCreated: 1, replays: 1 });
    });

    it('refuses a refund past what is left on the charge, the way Stripe caps it', async () => {
      const intentId = await captured();
      await control.refundOutOfBand(intentId, { amount: 50_000, deliverWebhook: false });

      const tooLarge = await thrown(refund(intentId, 'refund:1:0'));
      await refund(intentId, 'refund:1:1', CAPTURED - 50_000);
      const nothingLeft = await thrown(refund(intentId, 'refund:1:2'));

      expect(tooLarge).toMatchObject({ statusCode: 400, code: 'amount_too_large', param: 'amount' });
      expect(nothingLeft).toMatchObject({ statusCode: 400, code: 'charge_already_refunded' });
      expect(await control.intentStats(intentId)).toMatchObject({
        refundRequests: 3,
        refundsCreated: 2,
        refundedAmount: CAPTURED,
      });
    });

    it('refuses to refund an intent that was never captured', async () => {
      const { intentId } = await authorized();

      const error = await thrown(refund(intentId, 'refund:1:0'));

      expect(error.statusCode).toBe(400);
      expect((await control.intentStats(intentId)).refundsCreated).toBe(0);
    });

    it('keeps a 500 under its key without refunding, so only a new key refunds', async () => {
      const intentId = await captured();
      await control.setFault({ mode: '500', target: 'refund' });

      const first = await thrown(refund(intentId, 'refund:1:0'));
      const replayed = await thrown(refund(intentId, 'refund:1:0'));
      const listed = await stripe.refunds.list({ payment_intent: intentId });
      await refund(intentId, 'refund:1:1');

      expect([first.statusCode, replayed.statusCode]).toEqual([500, 500]);
      expect(listed.data).toEqual([]);
      expect(await control.intentStats(intentId)).toMatchObject({
        refundsCreated: 1,
        refundKeys: ['refund:1:0', 'refund:1:1'],
      });
    });

    it('can refund and still answer 500, leaving the refund to be found by intent', async () => {
      const intentId = await captured();
      await control.setFault({ mode: 'apply_then_500', target: 'refund' });

      const error = await thrown(refund(intentId, 'refund:1:0'));
      const listed = await stripe.refunds.list({ payment_intent: intentId });

      expect(error.statusCode).toBe(500);
      expect(listed.data).toMatchObject([{ status: 'succeeded', amount: CAPTURED, metadata: { order_id: '1' } }]);
      expect(await control.faultsFired()).toEqual({ 'apply_then_500:refund': 1 });
    });

    // A client timeout, as the payment-service meets a hang: the SDK resends once on a reset socket.
    it('drops a refund call it hangs on without refunding anything', async () => {
      const intentId = await captured();
      const impatient = new Stripe(`sk_test_${randomBytes(12).toString('hex')}`, {
        ...control.apiAddress(),
        maxNetworkRetries: 0,
        timeout: 300,
      });
      await control.setFault({ mode: 'hang', target: 'refund', ms: 2_000 });

      const error = await thrown(
        impatient.refunds.create({ payment_intent: intentId, amount: CAPTURED }, { idempotencyKey: 'refund:1:0' }),
      );

      expect(error).toBeInstanceOf(Stripe.errors.StripeConnectionError);
      expect(await control.intentStats(intentId)).toMatchObject({ refundRequests: 1, refundsCreated: 0 });
    });

    it('disarms the faults left without forgetting the refunds it holds', async () => {
      const intentId = await captured();
      await control.setFault({ mode: '500', target: 'refund', times: 5 });

      await thrown(refund(intentId, 'refund:1:0'));
      await control.clearFaults();
      const created = await refund(intentId, 'refund:1:1');

      expect(created.status).toBe('succeeded');
      expect(await control.faultsFired()).toEqual({ '500:refund': 1 });
    });

    it('refuses a refund under a key whose first request is still running (409)', async () => {
      const intentId = await captured();
      await control.setFault({ mode: 'slow', target: 'refund', ms: 1_500 });

      const first = refund(intentId, 'refund:1:0');
      await expect.poll(async () => (await control.intentStats(intentId)).refundRequests).toBe(1);
      const error = await thrown(refund(intentId, 'refund:1:0'));

      expect(error.statusCode).toBe(409);
      expect(error.rawType).toBe('idempotency_error');
      expect((await first).status).toBe('succeeded');
      expect(await control.intentStats(intentId)).toMatchObject({ refundsCreated: 1, conflicts409: 1 });
    });

    it('holds a refund pending until it is settled, then signs the refund event it sends', async () => {
      const intentId = await captured();
      await control.setFault({ mode: 'pending', target: 'refund' });

      const pending = await refund(intentId, 'refund:1:0');
      const settled = await control.settleRefund(pending.id, { status: 'succeeded', deliverWebhook: true });
      const [delivery] = await control.webhookSink();
      const event = stripe.webhooks.constructEvent(delivery.body, delivery.signature, WEBHOOK_SECRET);

      expect(pending.status).toBe('pending');
      expect(settled.webhook?.status).toBe(200);
      expect(event.type).toBe('refund.updated');
      expect(event.data.object).toMatchObject({ id: pending.id, status: 'succeeded', payment_intent: intentId });
      expect((await stripe.refunds.retrieve(pending.id)).status).toBe('succeeded');
    });

    it('fails a refund it settles as failed, sends refund.failed, and gives the amount back to refund', async () => {
      const intentId = await captured();
      const created = await refund(intentId, 'refund:1:0');

      await control.settleRefund(created.id, { status: 'failed', deliverWebhook: true });
      const [delivery] = await control.webhookSink();
      const event = stripe.webhooks.constructEvent(delivery.body, delivery.signature, WEBHOOK_SECRET);
      const read = await stripe.refunds.retrieve(created.id);

      expect(event.type).toBe('refund.failed');
      expect(read).toMatchObject({ status: 'failed', failure_reason: 'expired_or_canceled_card' });
      expect((await control.intentStats(intentId)).refundedAmount).toBe(0);
      expect((await refund(intentId, 'refund:1:1')).status).toBe('succeeded');
    });

    it('refunds out of band with no metadata, like the dashboard, and sends a signed refund.created', async () => {
      const intentId = await captured();

      const { refundId, webhook } = await control.refundOutOfBand(intentId);
      const [delivery] = await control.webhookSink();
      const event = stripe.webhooks.constructEvent(delivery.body, delivery.signature, WEBHOOK_SECRET);
      const listed = await stripe.refunds.list({ payment_intent: intentId });

      expect(webhook?.status).toBe(200);
      expect(event.type).toBe('refund.created');
      expect(event.data.object).toMatchObject({ id: refundId, metadata: {}, amount: CAPTURED });
      expect(listed.data).toMatchObject([{ id: refundId, metadata: {}, status: 'succeeded' }]);
      expect(await control.intentStats(intentId)).toMatchObject({ refundRequests: 0, refundsCreated: 1 });
    });

    it('lists an intent’s refunds newest first, whatever their metadata', async () => {
      const intentId = await captured();
      const { refundId: dashboard } = await control.refundOutOfBand(intentId, {
        amount: 40_000,
        deliverWebhook: false,
      });
      const shop = await refund(intentId, 'refund:1:0', CAPTURED - 40_000);

      const listed = await stripe.refunds.list({ payment_intent: intentId, limit: 100 });

      expect(listed.data.map((r) => r.id)).toEqual([shop.id, dashboard]);
    });
  });
});
