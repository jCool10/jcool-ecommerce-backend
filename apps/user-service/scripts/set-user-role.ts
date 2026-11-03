/**
 * Changes a user's role and revokes every access token minted under the old one:
 *
 *   DATABASE_URL=… REDIS_URL=… tsx scripts/set-user-role.ts <email> <ADMIN|CUSTOMER>
 *
 * The role rides in the access token, so a demotion alone would leave the old token an admin for up
 * to `JWT_ACCESS_TTL`. The session epoch is bumped with it, so those tokens are refused at once;
 * refresh tokens are left alone and the next refresh carries the new role.
 */
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { normalizeEmail } from '@jcool/kernel';
import { ROLES, type Role } from '@jcool/platform/rbac';
import { RAISE_EPOCH } from '../src/modules/user/infrastructure/redis-session-epoch.publisher';

function parseArgs(argv: string[]): { email: string; role: Role } {
  const [email, role, ...extra] = argv;
  if (!email || !role || extra.length > 0 || !(ROLES as readonly string[]).includes(role)) {
    throw new Error(`usage: set-user-role <email> <${ROLES.join('|')}>`);
  }
  return { email: normalizeEmail(email), role: role as Role };
}

async function main(): Promise<void> {
  const { email, role } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');

  const pool = new Pool({ connectionString, max: 1 });
  const redis = new Redis(redisUrl);
  try {
    // One statement, so the role and the epoch that revokes the old role's tokens commit together.
    const { rows } = await pool.query<{ id: string; token_epoch: number }>(
      `UPDATE users SET role = $2, token_epoch = token_epoch + 1, updated_at = now()
        WHERE email = $1
        RETURNING id, token_epoch`,
      [email, role],
    );
    if (rows.length === 0) throw new Error(`no user with email ${email}`);
    const { id, token_epoch: epoch } = rows[0];
    console.log(`User ${id} is now ${role}; session epoch ${epoch}.`);

    try {
      await redis.eval(RAISE_EPOCH, 1, SESSION_EPOCH_KEY_PREFIX + id, epoch);
    } catch (error) {
      throw new Error(
        'the database is updated but the epoch is not in Redis yet; the reconciler publishes it within one SESSION_EPOCH_RECONCILE_INTERVAL_MS',
        { cause: error },
      );
    }
    console.log('Epoch published: tokens minted before this are refused.');
  } finally {
    await Promise.all([pool.end(), redis.quit()]);
  }
}

void main().catch((error: unknown) => {
  console.error('Set user role failed:', error);
  process.exit(1);
});
