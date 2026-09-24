import { Table, getTableName, is } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';

const DECLARED = Object.values(schema)
  .filter((value) => is(value, Table))
  .map(getTableName);

// The worker database is cloned from a template that ran the whole migration chain, so this reads
// what the chain leaves behind rather than what the schema declares.
describe('The api database tables (integration)', () => {
  let app: Awaited<ReturnType<typeof createTestAppWithPool>>['app'];
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);

  it('holds every table the api declares', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = rows.map((row) => row.tablename);

    expect(DECLARED).toContain('orders');
    expect(DECLARED.filter((name) => !present.includes(name))).toEqual([]);
  });
});
