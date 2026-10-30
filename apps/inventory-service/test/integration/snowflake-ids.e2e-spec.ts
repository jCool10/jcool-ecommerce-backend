import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { reservationRoutes } from '@jcool/internal-contracts';
import { authHeader } from '../setup/bearer.helper';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, internalPost, resetDatabaseBeforeEach } from '../setup/harness';
import { STUB_NODE_ID, testId } from '../setup/id-service-stub';

describe('Snowflake ids (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // The stub's node, not just a routable id: an id minted anywhere but the id-service fails here.
  const expectMintedIds = async (sql: string): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(sql);
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(decode(id).nodeId, id).toBe(STUB_NODE_ID);
  };

  it('mints stock level and reservation ids through the id-service', async () => {
    const { accessToken } = await createTestAdminPrincipal(app);
    const variantId = testId();

    await request(app.getHttpServer())
      .put(`/admin/inventory/${variantId}`)
      .set(authHeader(accessToken))
      .send({ quantityOnHand: 3 })
      .expect(200);
    await internalPost(app, reservationRoutes.try(testId()))
      .send({ lines: [{ variantId, quantity: 1 }], holdUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(201);

    await expectMintedIds('SELECT id::text FROM stock_levels');
    await expectMintedIds('SELECT id::text FROM reservations');
  });
});
