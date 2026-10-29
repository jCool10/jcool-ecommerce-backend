import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { isProviderUnavailable, paymentRoutes } from '@jcool/internal-contracts';
import { authorizeSession } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  internalPost,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { STUB_NODE_ID, idServiceStub, testId } from '../setup/id-service-stub';

const sessionBody = () => ({
  amountMinor: 150_000,
  currency: 'VND',
  expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
});

describe('Snowflake ids (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithFakeGateway('whsec_snowflake_ids_e2e_000000'));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(async () => (await idServiceStub()).reset());

  // The stub's node, not just a routable id: an id minted anywhere but the id-service fails here.
  const expectMintedIds = async (sql: string, params: unknown[] = []): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(decode(id).nodeId, id).toBe(STUB_NODE_ID);
  };

  it('mints the payment, its webhook events and outbox rows through the id-service', async () => {
    const orderId = testId();
    const { body } = await internalPost(app, paymentRoutes.session(orderId)).send(sessionBody()).expect(200);
    await authorizeSession(app, body.providerSessionId, orderId);

    expect(decode(body.paymentId).nodeId, body.paymentId).toBe(STUB_NODE_ID);
    await expectMintedIds('SELECT id FROM payments WHERE order_id = $1', [orderId]);
    await expectMintedIds('SELECT id FROM webhook_events');
    await expectMintedIds('SELECT id FROM outbox');
  });

  // The header is claimed before the mint, so only the attempt is missing, and the retry adds it.
  it('answers 503 and starts no attempt when the id service cannot mint', async () => {
    const orderId = testId();
    (await idServiceStub()).fail(503);

    const refused = await internalPost(app, paymentRoutes.session(orderId)).send(sessionBody()).expect(503);
    expect(isProviderUnavailable(refused.status, refused.body)).toBe(false);
    expect((await pool.query('SELECT 1 FROM payments')).rows).toEqual([]);

    (await idServiceStub()).reset();
    await internalPost(app, paymentRoutes.session(orderId)).send(sessionBody()).expect(200);
    await expectMintedIds('SELECT id FROM payments WHERE order_id = $1', [orderId]);
  });
});
