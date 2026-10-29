/**
 * Drain one queue's dead-letter queue back onto it:
 *   pnpm queue:replay-dlq --queue order-events                   # list what would be replayed, change nothing
 *   pnpm queue:replay-dlq --queue order-events --apply           # actually replay
 *   pnpm queue:replay-dlq --queue api-events --apply --limit 20
 *   pnpm queue:replay-dlq --queue order-events --apply --force   # past the retention horizon; it can never
 *                                                                # override a claim that is actually there
 * In a deployed container (no devDependencies, so no `tsx`), the compiled twin:
 *   pnpm queue:replay-dlq:prod --queue order-events --apply
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
import { buildJobOptions, replayDeadLetters, type InboxClaimLookup } from '@jcool/messaging';
import { inbox } from '@jcool/messaging/schema';
import configuration from '@shared/config/configuration';
import { API_CONSUMED_QUEUES } from '../event-routes';

const DAY_MS = 86_400_000;

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const limitArg = argAfter('--limit');
const limit = limitArg === undefined ? 100 : Number(limitArg);
const queueArg = argAfter('--queue');

async function main(): Promise<void> {
  // Required: with one dead-letter queue per queue, a default would be a guess at which one is on fire.
  const selected = API_CONSUMED_QUEUES.find(({ name }) => name === queueArg);
  if (!selected) {
    const valid = API_CONSUMED_QUEUES.map(({ name }) => name).join(', ');
    throw new Error(`--queue must be one of: ${valid}${queueArg === undefined ? '' : ` (got "${queueArg}")`}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
  }

  // The app's own config factory, but read from THIS process's environment, so every value here can
  // silently disagree with the deployment being repaired — the Redis it drains, the inbox it checks,
  // the retention window, the retry policy it replays under. Only the window is echoed below.
  const { redis, queue, database, retention } = configuration();
  if (!redis.url) throw new Error('REDIS_URL is not set');
  if (!database.url) throw new Error('DATABASE_URL is not set — the inbox check cannot be skipped');
  const prefix = queue.prefix;

  // maxRetriesPerRequest: null is BullMQ's requirement — it refuses a finite budget, not a preference.
  const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
  const mainQueue = new Queue(selected.name, {
    connection,
    prefix,
    // BullMQ stamps these onto the job at add time, so a queue built without them replays with
    // attempts: 0 — no retry budget on the one path where the message is known to have failed, and
    // a failed record kept forever instead of expiring with the inbox claim that guards it.
    defaultJobOptions: buildJobOptions(queue.consumerAttempts, queue.consumerBackoffMs),
  });
  // Still no defaults here: nothing consumes a DLQ, so retention rules would delete the record it
  // exists to keep.
  const dlq = new Queue(selected.dlq, { connection, prefix });

  // One connection: this reads at most `limit` rows, one at a time, and then exits.
  const pool = new Pool({ connectionString: database.url, max: 1 });
  const db = drizzle(pool);

  const inboxLookup: InboxClaimLookup = async (messageId) => {
    const [row] = await db
      .select({ processedAt: inbox.processedAt })
      .from(inbox)
      .where(and(eq(inbox.consumer, selected.consumer), eq(inbox.messageId, messageId)))
      .limit(1);
    return row?.processedAt ?? null;
  };

  try {
    const summary = await replayDeadLetters(mainQueue, dlq, {
      limit,
      dryRun: !apply,
      inboxLookup,
      inboxRetentionMs: retention.inboxDays * DAY_MS,
      force,
      jobOptionsFor: (eventType) => selected.jobOptionsFor(eventType, queue.orderPaidAttempts),
    });

    // The window is printed because the guard is only as good as its match with the deployment whose
    // inbox is being swept, and nothing here can detect a mismatch.
    console.log(
      `\n--- dead-letter replay of ${selected.dlq} (${apply ? 'APPLY' : 'dry run'}, limit ${limit}, ` +
        `inbox window ${retention.inboxDays}d${force ? ', FORCED' : ''}) ---`,
    );
    if (summary.outcomes.length === 0) {
      console.log('dead-letter queue is empty');
    }
    for (const outcome of summary.outcomes) {
      // The diagnosis the header tells the operator to act on before replaying; Redis is the only
      // other place it exists, and this tool runs precisely when the app is what is broken. Labelled
      // because on a `replayed` line an unlabelled reason reads as a failure that just happened.
      const reason = outcome.failedReason ? ` [parked: ${outcome.failedReason}]` : '';
      const detail = outcome.detail ? ` — ${outcome.detail}` : '';
      console.log(`${outcome.status.padEnd(8)} ${outcome.eventType.padEnd(16)} ${outcome.messageId}${reason}${detail}`);
    }
    console.log(`\nreplayed: ${summary.replayed}   skipped: ${summary.skipped}`);
    if (!apply && summary.outcomes.length > 0) {
      console.log('re-run with --apply to replay these messages');
    }
  } finally {
    await mainQueue.close();
    await dlq.close();
    await connection.quit().catch(() => connection.disconnect());
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
