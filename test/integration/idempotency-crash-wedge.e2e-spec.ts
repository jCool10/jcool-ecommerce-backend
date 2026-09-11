import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStorePort,
} from '../../src/modules/order/application/ports/idempotency-store.port';
import { CheckoutOrderUseCase } from '../../src/modules/order/application/use-cases/checkout-order.use-case';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { buyerWithCart, seedSellableSku, type SellableSku } from '../setup/fixtures/order-flow.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const STOCK = 50;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// The pod is gone, so nothing it was holding gets a chance to run: half a second of tolerance is for
// the round-trip, not for anything the process might still do.
const CLOCK_TOLERANCE_MS = 5_000;

/**
 * A pod that is SIGKILLed — OOM, an evicted node, a failed liveness probe — runs no cleanup at all.
 * The distinction that matters here is between the row a crash leaves behind and the row the reclaim
 * tests hand-write: those backdate `expires_at` to reach the reclaim branch, so they never see the
 * lease a crash actually writes.
 */
describe('Idempotency after a crash mid-checkout (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let checkout: CheckoutOrderUseCase;
  let store: IdempotencyStorePort;
  let sku: SellableSku;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    checkout = app.get(CheckoutOrderUseCase);
    store = app.get<IdempotencyStorePort>(IDEMPOTENCY_STORE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const postOrder = (token: string, key: string) =>
    request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));

  const keyRow = async (key: string) =>
    (await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)))[0];

  const ordersOf = async (token: string) => {
    const res = await request(app.getHttpServer()).get('/orders').set(authHeader(token));
    return (res.body as { items: { id: string }[] }).items;
  };

  /**
   * The crash, at the only point where it does damage: the IN_PROGRESS row is committed and the
   * handler is under way. The process dies, so BOTH the handler and the interceptor's `catchError`
   * cleanup stop existing — mocking only the first would leave the row cleaned up, which is the
   * ordinary failure this is NOT about.
   */
  async function crashMidCheckout(token: string, key: string): Promise<void> {
    vi.spyOn(checkout, 'execute').mockRejectedValue(new Error('SIGKILL: pod evicted'));
    const remove = vi.spyOn(store, 'deleteInProgress').mockResolvedValue(undefined);

    await postOrder(token, key).expect(500);

    expect(remove).toHaveBeenCalled(); // the cleanup a live process would have run...
    vi.restoreAllMocks(); // ...and did not, because there was no process left to run it.
  }

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a key whose owner died is reclaimable within a window a client could
  //   plausibly wait out, and a client told to wait is told how long.
  // Violated at: src/modules/order/interface/idempotency.interceptor.ts:25 — `IDEMPOTENCY_TTL_MS` is
  //   a hardcoded 24h serving two different jobs at once: the replay window for a COMPLETED key
  //   (where 24h is the point) and the abandonment lease for an IN_PROGRESS one (where it is the
  //   whole outage). The 409 raised at :89 carries no `Retry-After` and no machine-readable reason,
  //   so a client cannot tell "your sibling request is running, retry in a moment" from "this key is
  //   dead for a day"; its only recovery is to mint a new key, which the idempotency contract exists
  //   to make unnecessary.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — IDEM-1.
  it('wedges a key for a full day when the pod dies mid-checkout, and never says so', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const key = randomUUID();

    await crashMidCheckout(token, key);

    // The lease a crash actually writes: a full day, not the minutes an in-flight sibling needs.
    const wedged = await keyRow(key);
    expect(wedged.status).toBe('IN_PROGRESS');
    expect(wedged.expiresAt.getTime() - Date.now()).toBeGreaterThan(ONE_DAY_MS - CLOCK_TOLERANCE_MS);

    // The client's honest retry, with the same key and the same body, as the contract invites.
    const retry = await postOrder(token, key).expect(409);
    expect(retry.body.message).toBe('A request with this Idempotency-Key is already in progress');
    // Nothing tells the caller this is a day and not a moment.
    expect(retry.headers['retry-after']).toBeUndefined();
    expect(retry.body).not.toHaveProperty('code');

    // Retrying does not renew the lease either, so waiting and retrying is the same 409 all day.
    expect((await keyRow(key)).expiresAt.getTime()).toBe(wedged.expiresAt.getTime());
    expect(await ordersOf(token)).toHaveLength(0);

    // The only recovery: abandon the key. The cart is untouched, so a new key still buys the order —
    // which is what makes this a client-visible contract gap rather than lost money.
    const fresh = await postOrder(token, randomUUID()).expect(201);
    expect(fresh.body.id).toBeDefined();
    expect(await ordersOf(token)).toHaveLength(1);
  });
});
