import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIN_ROUTABLE_ID } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID, SnowflakeGenerator } from '@jcool/id-generator';
import { bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { workerDatabaseUrl } from '../setup/worker-resources';

const CHECK_VIOLATION = '23514';
const FAMILY_ID = '00000000-0000-4000-8000-000000000000';

const TOKEN_TABLES = ['email_verification_tokens', 'password_reset_tokens', 'refresh_tokens'] as const;
type TokenTable = (typeof TOKEN_TABLES)[number];

const TOKEN_ID_COLUMNS: [TokenTable, string][] = [
  ['email_verification_tokens', 'id'],
  ['email_verification_tokens', 'user_id'],
  ['password_reset_tokens', 'id'],
  ['password_reset_tokens', 'user_id'],
  ['refresh_tokens', 'id'],
  ['refresh_tokens', 'user_id'],
  ['refresh_tokens', 'replaced_by_token_id'],
];

// Raw SQL on purpose: the column type already refuses these on a Drizzle write, and the database is
// what holds every other writer (psql, a restore, a script) to the same bound.
describe('Routable id CHECK constraints (integration)', () => {
  let pool: Pool;
  const generator = SnowflakeGenerator.create({ nodeId: SCRIPTS_NODE_ID });
  let tokenSeq = 0;

  const insertUser = (id: string, email = `id-check-${id}@test.local`) =>
    pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'not-a-real-hash')`, [id, email]);

  async function mintedUser(): Promise<string> {
    const email = `id-check-owner-${tokenSeq}@test.local`;
    const id = generator.generate(bucketForTestEmail(email));
    await insertUser(id, email);
    return id;
  }

  async function insertToken(table: TokenTable, overrides: Record<string, string | null> = {}): Promise<void> {
    const row: Record<string, unknown> = {
      id: generator.generate(0),
      user_id: overrides.user_id === undefined ? await mintedUser() : overrides.user_id,
      token_hash: `id-check-hash-${tokenSeq++}`,
      expires_at: new Date(Date.now() + 3_600_000),
      ...(table === 'refresh_tokens' ? { family_id: FAMILY_ID } : {}),
      ...overrides,
    };
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const refusal = (insert: Promise<unknown>): Promise<string> =>
    insert.then(
      () => 'accepted',
      (error: { code?: string; constraint?: string }) => `${error.code} ${error.constraint}`,
    );

  it('refuses a users.id below the routable floor', async () => {
    const outcomes: string[] = [];
    for (const id of ['4194303', '0', '-1']) outcomes.push(await refusal(insertUser(id)));

    expect(outcomes).toEqual(Array(3).fill(`${CHECK_VIOLATION} ck_users_id_routable`));
  });

  it('accepts a minted users.id, and the smallest routable one', async () => {
    await mintedUser();
    await insertUser(MIN_ROUTABLE_ID.toString());

    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM users`);
    expect(rows[0].count).toBe('2');
  });

  it('refuses a non-routable value in every token id column', async () => {
    const outcomes: string[] = [];
    for (const [table, column] of TOKEN_ID_COLUMNS) outcomes.push(await refusal(insertToken(table, { [column]: '0' })));

    expect(outcomes).toEqual(
      TOKEN_ID_COLUMNS.map(([table, column]) => `${CHECK_VIOLATION} ck_${table}_${column}_routable`),
    );
  });

  // Only a rotated token has a successor; a CHECK lets NULL through.
  it('accepts token rows with minted ids, with or without a successor', async () => {
    for (const table of TOKEN_TABLES) await insertToken(table);
    await insertToken('refresh_tokens', { replaced_by_token_id: generator.generate(0) });

    const counts: string[] = [];
    for (const table of TOKEN_TABLES) {
      counts.push((await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0].count);
    }
    expect(counts).toEqual(['1', '1', '2']);
  });
});
