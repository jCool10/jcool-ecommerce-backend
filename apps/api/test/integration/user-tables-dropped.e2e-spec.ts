import { Table, getTableName, is } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';

const DROPPED = ['users', 'email_verification_tokens', 'password_reset_tokens', 'refresh_tokens', 'identity_key_pin'];

/** Every table the api still declares. A drop migration that reached one of these would fail here. */
const DECLARED = Object.values(schema)
  .filter((value) => is(value, Table))
  .map(getTableName);

/**
 * Runs against the worker database, which is cloned from a template carrying the whole migration
 * chain — so this asserts what the chain actually leaves behind, not what the schema says.
 */
describe('The api database after the user tables were dropped (integration)', () => {
  let app: Awaited<ReturnType<typeof createTestAppWithPool>>['app'];
  let pool: Pool;

  const tableNames = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    return rows.map((row) => row.tablename);
  };

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);

  it('holds none of the user tables', async () => {
    const present = await tableNames();

    expect(DROPPED.filter((name) => present.includes(name))).toEqual([]);
  });

  it('still holds every table the api declares', async () => {
    const present = await tableNames();

    expect(DECLARED.filter((name) => !present.includes(name))).toEqual([]);
  });

  it('drops the role enum with them', async () => {
    const { rowCount } = await pool.query(`SELECT 1 FROM pg_type WHERE typname = 'role'`);

    expect(rowCount).toBe(0);
  });
});
