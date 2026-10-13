import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import {
  authorizeAndRelay,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  seedSellableSku,
  waitForSagaClosed,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { checkoutSessionCompleted, signWebhookAs } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_saga_observability_0123456789';
const STOCK = 10;
const QUANTITY = 2;
// The shortest deadline the config rules allow: the saga's timers live on the Temporal server, so
// expiry is waited for rather than forced.
const SHORT_DEADLINES = {
  CHECKOUT_PAYMENT_DEADLINE_SEC: '31',
  CHECKOUT_PAY_CUTOFF_SEC: '30',
  CHECKOUT_HOLD_SAFETY_SEC: '30',
  SAGA_AUTH_GRACE_SEC: '1',
  PAYMENT_SESSION_MIN_TTL_SEC: '0',
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
};
const EXPIRY_WAIT_MS = 50_000;
const TRIGGERS = [
  'try_failed',
  'expired',
  'cancelled',
  'commit_conflict',
  'capture_failed',
  'late_authorization',
  'amount_mismatch',
] as const;

describe('Saga observability (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      ...SHORT_DEADLINES,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  async function scrape(): Promise<string> {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    return text;
  }

  // 0 for an untouched series. Counters outlive the database reset, so every assertion is a delta.
  function sample(text: string, name: string, labels: Record<string, string>): number {
    const pairs = Object.entries(labels);
    for (const line of text.split('\n')) {
      // Anchored on the delimiter after the name, so a longer series sharing the prefix never matches.
      if (!line.startsWith(`${name}{`)) continue;
      if (pairs.every(([key, value]) => line.includes(`${key}="${value}"`))) {
        return Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
    return 0;
  }

  const cancelOrder = (order: OpenOrder) =>
    request(app.getHttpServer()).post(`/orders/${order.orderId}/cancel`).set(authHeader(order.token));

  const step = (text: string, name: string, outcome: 'success' | 'failed') =>
    sample(text, 'saga_step_total', { step: name, outcome });
  const compensation = (text: string, trigger: string) => sample(text, 'saga_compensation_total', { trigger });
  const compensations = (text: string) => TRIGGERS.map((trigger) => compensation(text, trigger));

  it('counts each step of a paid checkout as a success and starts no compensation', async () => {
    const before = await scrape();

    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await authorizeAndRelay(app, gateway, order);

    const after = await scrape();
    for (const name of ['try_reserve', 'open_session', 'commit_stock', 'capture']) {
      expect({ name, delta: step(after, name, 'success') - step(before, name, 'success') }).toEqual({ name, delta: 1 });
    }
    expect(compensations(after)).toEqual(compensations(before));
  });

  it('counts an expired order as one compensation, and each undo it ran as a step', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await waitForSagaClosed(app, order.orderId, { timeoutMs: EXPIRY_WAIT_MS });

    const after = await scrape();
    expect(compensation(after, 'expired') - compensation(before, 'expired')).toBe(1);
    // RELEASE_STOCK and CANCEL_PAYMENT.
    expect(step(after, 'compensate', 'success') - step(before, 'compensate', 'success')).toBe(2);
  });

  it('counts a cancelled order as one compensation, and each undo it ran as a step', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await cancelOrder(order).expect(200);
    await waitForSagaClosed(app, order.orderId);

    const after = await scrape();
    expect(compensation(after, 'cancelled') - compensation(before, 'cancelled')).toBe(1);
    expect(step(after, 'compensate', 'success') - step(before, 'compensate', 'success')).toBe(2);
  });

  it('counts money that arrives after the order was given up as a late authorization of its own', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    gateway.authorize(order.sessionId);
    const completed = checkoutSessionCompleted(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' });
    await postWebhook(app, signWebhookAs(gateway, completed)).expect(200);
    // The authorization is recorded but not yet delivered to the saga when the buyer cancels.
    await cancelOrder(order).expect(200);
    await waitForSagaClosed(app, order.orderId);
    const before = await scrape();

    await drainDomainEvents(app);

    const after = await scrape();
    expect(compensation(after, 'late_authorization') - compensation(before, 'late_authorization')).toBe(1);
    expect(compensation(after, 'cancelled')).toBe(compensation(before, 'cancelled'));
    expect((await readOrder(app, order.orderId)).status).toBe('CANCELLED');
  });

  it('keeps the order id out of every saga label', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await cancelOrder(order).expect(200);
    await waitForSagaClosed(app, order.orderId);

    const series = (await scrape()).split('\n').filter((line) => line.startsWith('saga_'));

    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      expect(line).not.toContain(order.orderId);
    }
  });
});
