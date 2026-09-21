/**
 * The load-test account: verified, so it can log in without a mail round trip. The api's perf seed
 * builds its cart and looks the account up through `/auth/me`, so run this one first.
 */
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { normalizeEmail } from '@jcool/kernel';
import { users } from '../src/modules/user/infrastructure/schema/user.schema';
import { scriptsIdentity } from './scripts-identity';
import { withScriptsMintLock } from './scripts-mint-lock';

const PERF_USER_EMAIL = normalizeEmail('perf@loadtest.jcool.local');

// Overridable because this account authenticates over HTTP; the default is for a throwaway database.
function perfUserPassword(): string {
  return process.env.PERF_USER_PASSWORD ?? 'perf-load-not-a-real-secret';
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to seed the perf user');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-perf-user refuses to run with NODE_ENV=production (throwaway data only)');
  }

  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);
  try {
    if (process.argv.includes('--clean')) {
      const removed = await db.delete(users).where(eq(users.email, PERF_USER_EMAIL)).returning({ id: users.id });
      console.log(`Removed ${removed.length} perf user row(s) (${PERF_USER_EMAIL}).`);
      return;
    }

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, PERF_USER_EMAIL));
    if (existing) {
      console.log(`Perf user ${PERF_USER_EMAIL} already present (user ${existing.id}).`);
      return;
    }

    // argon2id is deliberately slow, so the hash is only paid for when the row is actually created.
    const passwordHash = await argon2.hash(perfUserPassword(), { type: argon2.argon2id });
    const [created] = await db
      .insert(users)
      .values({
        id: await withScriptsMintLock(pool, () => scriptsIdentity().mintUserId(PERF_USER_EMAIL)),
        email: PERF_USER_EMAIL,
        passwordHash,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    console.log(`Perf user ${PERF_USER_EMAIL} ${created ? `created (user ${created.id})` : 'created concurrently'}.`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Perf user seed failed:', error);
  process.exit(1);
});
