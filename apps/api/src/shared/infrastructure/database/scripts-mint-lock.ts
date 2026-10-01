import type { ClientBase, Pool } from 'pg';
import { NODE_COUNT, SEQUENCE_BITS, decode } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID, SnowflakeGenerator } from '@jcool/id-generator';

// Any fixed pair identifies the lock; these two are arbitrary and only have to stay put.
const LOCK_NAMESPACE = 0x1d_00_0002;
const LOCK_KEY = 1;

// Every table a seed script writes: the next run's floor is read back from them.
const SEEDED_TABLES = ['categories', 'products', 'product_variants', 'prices', 'stock_levels', 'carts', 'cart_items'];

export type ScriptsMint = () => string;

/**
 * Seeds mint in process on the node reserved for scripts, so they need no running id service. The
 * layout carries no random bits, so two runs at once would emit the same ids: this lock keeps them
 * apart, and the floor read under it keeps a run whose clock sits behind an earlier run's last
 * millisecond from replaying that run's ids. `run` must write its rows before it returns.
 */
export async function withScriptsMintLock<T>(pool: Pool, run: (mint: ScriptsMint) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      LOCK_NAMESPACE,
      LOCK_KEY,
    ]);
    if (!rows[0]?.locked) {
      throw new Error('Another seed script is already minting ids. Wait for it to finish, then run this again.');
    }
    try {
      const generator = SnowflakeGenerator.create({
        nodeId: SCRIPTS_NODE_ID,
        floorMs: await lastScriptsMintMs(client),
      });
      return await run(() => generator.generate());
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// The timestamp is the id's top field, so the largest id on the node carries its newest timestamp.
async function lastScriptsMintMs(client: ClientBase): Promise<number | undefined> {
  const perTable = SEEDED_TABLES.map((table) => `SELECT max(id) AS id FROM ${table} WHERE (id >> $1) & $2 = $3`);
  const { rows } = await client.query<{ id: string | null }>(
    `SELECT max(id)::text AS id FROM (${perTable.join(' UNION ALL ')}) AS seeded`,
    [SEQUENCE_BITS, NODE_COUNT - 1, SCRIPTS_NODE_ID],
  );
  const id = rows[0]?.id;
  return id ? decode(id).tsMs : undefined;
}
