/**
 * Drain the domain-events dead-letter queue back onto the main queue:
 *   npm run queue:replay-dlq                       # list what would be replayed, change nothing
 *   npm run queue:replay-dlq -- --apply            # actually replay
 *   npm run queue:replay-dlq -- --apply --limit 20
 *   npm run queue:replay-dlq -- --apply --force    # past the retention horizon (read below first)
 * In a deployed container (no devDependencies, so no `tsx`), the compiled twin:
 *   npm run queue:replay-dlq:prod -- --apply
 *
 * Every candidate is checked against the inbox first: once a claim has been swept, "no claim" no
 * longer means "never applied", so a message whose claim may have aged out is refused unless
 * `--force`. `--force` cannot override a claim that is actually there. See `dead-letter.replay.ts`.
 *
 * A replay cannot fix the reason the message failed — read the printed `failedReason` and deploy the
 * fix first, or the same messages come straight back.
 *
 * Runs standalone rather than booting Nest, since a replay happens while the app is what is broken.
 * Needs Redis AND Postgres. Lives under `src/` because `scripts/` is excluded from the build and
 * `tsx` is a devDependency, so a `scripts/` entrypoint cannot run in the deployed image.
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import configuration from '@shared/config/configuration';
import { inbox } from '../inbox/schema/inbox.schema';
import { replayDeadLetters, type InboxClaimLookup } from './dead-letter.replay';
import { DOMAIN_EVENTS_CONSUMER, QUEUE_DOMAIN_EVENTS, QUEUE_DOMAIN_EVENTS_DLQ } from './queue.constants';

const DAY_MS = 86_400_000;

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg === -1 ? 100 : Number(process.argv[limitArg + 1]);

async function main(): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${process.argv[limitArg + 1]}"`);
  }

  // The app's own config factory, so prefix and defaults match what the app writes under. It still
  // reads THIS process's environment though: a wrong prefix fails safe (empty queue), a wrong
  // retention window does not — hence it is echoed in the header below.
  const { redis, queue, database, retention } = configuration();
  if (!redis.url) throw new Error('REDIS_URL is not set');
  if (!database.url) throw new Error('DATABASE_URL is not set — the inbox check cannot be skipped');
  const prefix = queue.prefix;

  // maxRetriesPerRequest: null is BullMQ's requirement, not a preference — it refuses to build on a
  // connection with a finite budget.
  const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
  const domainEvents = new Queue(QUEUE_DOMAIN_EVENTS, { connection, prefix });
  const dlq = new Queue(QUEUE_DOMAIN_EVENTS_DLQ, { connection, prefix });

  // One connection: this reads at most `limit` rows, one at a time, and then exits.
  const pool = new Pool({ connectionString: database.url, max: 1 });
  const db = drizzle(pool);

  const inboxLookup: InboxClaimLookup = async (messageId) => {
    const [row] = await db
      .select({ processedAt: inbox.processedAt })
      .from(inbox)
      .where(and(eq(inbox.consumer, DOMAIN_EVENTS_CONSUMER), eq(inbox.messageId, messageId)))
      .limit(1);
    return row?.processedAt ?? null;
  };

  try {
    const summary = await replayDeadLetters(domainEvents, dlq, {
      limit,
      dryRun: !apply,
      inboxLookup,
      inboxRetentionMs: retention.inboxDays * DAY_MS,
      force,
    });

    // The window is printed because the guard is only as good as it matching the deployment whose
    // inbox is being swept, and nothing here can detect a mismatch.
    console.log(
      `\n--- dead-letter replay (${apply ? 'APPLY' : 'dry run'}, limit ${limit}, ` +
        `inbox window ${retention.inboxDays}d${force ? ', FORCED' : ''}) ---`,
    );
    if (summary.outcomes.length === 0) {
      console.log('dead-letter queue is empty');
    }
    for (const outcome of summary.outcomes) {
      const detail = outcome.detail ? ` — ${outcome.detail}` : '';
      console.log(`${outcome.status.padEnd(8)} ${outcome.eventType.padEnd(16)} ${outcome.messageId}${detail}`);
    }
    console.log(`\nreplayed: ${summary.replayed}   skipped: ${summary.skipped}`);
    if (!apply && summary.outcomes.length > 0) {
      console.log('re-run with --apply to replay these messages');
    }
  } finally {
    await domainEvents.close();
    await dlq.close();
    await connection.quit().catch(() => connection.disconnect());
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
