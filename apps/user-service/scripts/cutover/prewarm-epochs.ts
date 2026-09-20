/**
 * Writes every user's session epoch into Redis before the api starts reading it there:
 *
 *   USER_DATABASE_URL=… REDIS_URL=… tsx scripts/cutover/prewarm-epochs.ts
 *
 * Read-through would fill the keys one login at a time, and until a key exists the api has to ask
 * the user-service for it — so the first minutes after the flip would put the whole logged-in
 * population through that path. Run it inside the write freeze, after the copy verifies.
 */
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { RAISE_EPOCH } from '../../src/modules/user/infrastructure/redis-session-epoch.publisher';

const BATCH = 5_000;
const SCAN_START = '00000000-0000-0000-0000-000000000000';

async function main(): Promise<void> {
  const connectionString = process.env.USER_DATABASE_URL;
  if (!connectionString) throw new Error('USER_DATABASE_URL is required');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const redis = new Redis(redisUrl);
  let cursor = SCAN_START;
  let written = 0;

  try {
    for (;;) {
      const { rows } = await pool.query<{ id: string; token_epoch: number }>(
        `SELECT id, token_epoch FROM users WHERE id > $1 ORDER BY id LIMIT $2`,
        [cursor, BATCH],
      );
      if (rows.length === 0) break;

      // SET-max, never a plain SET: a read-through fill or a bump racing this one must not be
      // lowered back. Pipelined, because a round trip per user is minutes at production row counts.
      const pipeline = redis.pipeline();
      for (const row of rows) {
        pipeline.eval(RAISE_EPOCH, 1, SESSION_EPOCH_KEY_PREFIX + row.id, row.token_epoch);
      }
      const failure = (await pipeline.exec())?.find(([error]) => error !== null)?.[0];
      if (failure) throw new Error('an epoch write failed', { cause: failure });

      written += rows.length;
      cursor = rows[rows.length - 1].id;
      console.log(`  ${written} epochs written`);
    }
    console.log(`Prewarmed ${written} epochs.`);
  } finally {
    await Promise.all([pool.end(), redis.quit()]);
  }
}

void main().catch((error: unknown) => {
  console.error('Epoch prewarm failed:', error);
  process.exit(1);
});
