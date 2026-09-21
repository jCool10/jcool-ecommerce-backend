import type { Pool } from 'pg';

// Any fixed pair identifies the lock; these two are arbitrary and only have to stay put.
const LOCK_NAMESPACE = 0x1d_00_0001;
const LOCK_KEY = 1;

/**
 * Serializes every script that mints on `SCRIPTS_NODE_ID`.
 *
 * The id layout carries no random bits, so two generators on one node id that start inside the same
 * millisecond emit the same `(ts, node, seq)` triple and therefore the same id. The id service is
 * protected from that by its lease; the reserved script node has nothing but this lock.
 *
 * `pg_try_advisory_lock` rather than the blocking form: a second run should say so and stop, not
 * queue behind a seed that may take an hour. The lock is session-scoped, so a crashed run releases
 * it when its connection closes.
 */
export async function withScriptsMintLock<T>(pool: Pool, run: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      LOCK_NAMESPACE,
      LOCK_KEY,
    ]);
    if (!rows[0]?.locked) {
      throw new Error(
        'Another seed script is already minting on the reserved script node. Two of them at once ' +
          'produce duplicate ids. Wait for it to finish, then run this again.',
      );
    }
    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
