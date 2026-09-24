import type { INestApplication } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalizeOrderUseCase, SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import {
  lapseReservation,
  placeAndOpenSession,
  postWebhook,
  seedSellableSku,
  signOutcome,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAppWithFakeGateway } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';

const WEBHOOK_SECRET = 'whsec_e2e_saga_observability_0123456789';
const STOCK = 10;
const QUANTITY = 2;
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };

describe('Saga observability (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let sweep: SweepExpiredReservationsUseCase;
  let finalize: FinalizeOrderUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    sweep = app.get(SweepExpiredReservationsUseCase);
    finalize = app.get(FinalizeOrderUseCase);
  });

  // Also clears the pinned token.
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  async function scrape(): Promise<string> {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    return text;
  }

  // 0 for an untouched series. Counters outlive `resetDatabase`, so every assertion is a delta.
  function sample(text: string, name: string, labels: Record<string, string> = {}): number {
    const pairs = Object.entries(labels);
    for (const line of text.split('\n')) {
      // Anchored on the delimiter after the name, so a longer series sharing the prefix never matches.
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (pairs.every(([key, value]) => line.includes(`${key}="${value}"`))) {
        return Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
    return 0;
  }

  const step = (text: string, name: string, outcome: string) =>
    sample(text, 'saga_step_total', { step: name, outcome });
  const compensation = (text: string, trigger: string) => sample(text, 'saga_compensation_total', { trigger });

  it('counts a failed payment as a compensation, attributed to the payment', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await postWebhook(
      app,
      signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'FAILED', 'evt_obs_failed'),
    ).expect(200);

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success') + 1);
    expect(compensation(after, 'payment_failed')).toBe(compensation(before, 'payment_failed') + 1);
    expect(compensation(after, 'ttl_expired')).toBe(compensation(before, 'ttl_expired'));
  });

  // At-least-once delivery repeats settlements; counting every arrival would measure the transport.
  it('counts one step for a settlement applied twice', async () => {
    const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);
    const before = await scrape();

    await expect(finalize.execute({ orderId, outcome: OrderStatus.PAID })).resolves.toMatchObject({
      status: 'finalized',
    });
    await expect(finalize.execute({ orderId, outcome: OrderStatus.PAID })).resolves.toMatchObject({ status: 'noop' });

    const after = await scrape();
    expect(step(after, 'finalize', 'success')).toBe(step(before, 'finalize', 'success') + 1);
  });

  // Prometheus keeps a series per label combination, so an id in a label is a series per order.
  it('keeps the order id out of every saga label', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapseReservation(app, order.orderId);
    await sweep.execute(SWEEP_ALL);

    const series = (await scrape()).split('\n').filter((line) => line.startsWith('saga_'));

    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      expect(line).not.toContain(order.orderId);
    }
  });

  // Asserts what the call site hands the logger; pino adds the correlation fields when it serializes.
  it('warns with both statuses when it drops a conflicting late outcome', async () => {
    const warn = vi.spyOn(PinoLogger.prototype, 'warn');
    const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);
    await finalize.execute({ orderId, outcome: OrderStatus.PAID });

    await finalize.execute({ orderId, outcome: OrderStatus.FAILED });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        current: OrderStatus.PAID,
        incoming: OrderStatus.FAILED,
      }),
      'conflicting finalize ignored',
    );
  });
});
