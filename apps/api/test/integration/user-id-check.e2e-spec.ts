import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_ROUTABLE_ID } from '@jcool/id-codec';
import { mintTestUserId } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const COLUMNS = [
  {
    column: 'carts.user_id',
    constraint: 'ck_carts_user_id_routable',
    insert: (pool: Pool, userId: string) =>
      pool.query(`INSERT INTO carts (id, user_id) VALUES (gen_random_uuid(), $1)`, [userId]),
  },
  {
    column: 'orders.user_id',
    constraint: 'ck_orders_user_id_routable',
    insert: (pool: Pool, userId: string) =>
      pool.query(`INSERT INTO orders (id, user_id, currency, total_amount) VALUES (gen_random_uuid(), $1, 'VND', 0)`, [
        userId,
      ]),
  },
  {
    column: 'media_assets.uploaded_by',
    constraint: 'ck_media_assets_uploaded_by_routable',
    insert: (pool: Pool, userId: string) =>
      pool.query(
        `INSERT INTO media_assets (id, storage_key, content_type, uploaded_by)
         VALUES (gen_random_uuid(), gen_random_uuid()::text, 'image/png', $1)`,
        [userId],
      ),
  },
];

/** Raw SQL on purpose: the column type refuses these values before they reach Postgres. */
describe('User id columns (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it.each(COLUMNS)('$column accepts the lowest routable id and refuses one below', async ({ constraint, insert }) => {
    await expect(insert(pool, (MIN_ROUTABLE_ID - 1n).toString())).rejects.toMatchObject({
      code: '23514',
      constraint,
    });
    await expect(insert(pool, MIN_ROUTABLE_ID.toString())).resolves.toMatchObject({ rowCount: 1 });
    await expect(insert(pool, mintTestUserId('owner@test.local'))).resolves.toMatchObject({ rowCount: 1 });
  });
});
