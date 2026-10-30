import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_ROUTABLE_ID } from '@jcool/id-codec';
import { mintTestUserId } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const COLUMNS = [
  {
    column: 'orders.user_id',
    constraint: 'ck_orders_user_id_routable',
    insert: (pool: Pool, userId: string) =>
      pool.query(`INSERT INTO orders (id, user_id, currency, total_amount) VALUES ($2, $1, 'VND', 0)`, [
        userId,
        testId(),
      ]),
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
    await expect(insert(pool, mintTestUserId())).resolves.toMatchObject({ rowCount: 1 });
  });
});
