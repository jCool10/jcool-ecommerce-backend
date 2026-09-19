import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SESSION_EPOCH_KEY_PREFIX } from '../../src/modules/user/infrastructure/redis-session-epoch.publisher';
import { redisOf } from './harness';

/** What other services read; null when never published. */
export async function publishedEpoch(app: INestApplication, userId: string): Promise<number | null> {
  const raw = await redisOf(app).get(SESSION_EPOCH_KEY_PREFIX + userId);
  return raw === null ? null : Number(raw);
}

/** The source of truth. */
export async function storedEpoch(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0) throw new Error(`no user ${userId}`);
  return rows[0].token_epoch;
}
