/**
 * Drain the order-events dead-letter queue back onto it:
 *   pnpm queue:replay-dlq --queue order-events                   # list what would be replayed, change nothing
 *   pnpm queue:replay-dlq --queue order-events --apply           # actually replay
 *   pnpm queue:replay-dlq --queue order-events --apply --force   # past the retention horizon; it can never
 *                                                                # override a claim that is actually there
 * In the image: `node dist/shared/messaging/replay-dlq.cli.js --queue order-events --apply`.
 *
 * A replay cannot fix why the message failed: read the printed `failedReason` and deploy the fix first.
 * Runs without Nest, since a replay happens while the app is what is broken. Needs Redis and Postgres.
 */
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { buildJobOptions, replayDeadLetters, type InboxClaimLookup } from '@jcool/messaging';
import { inbox } from '@jcool/messaging/schema';
import configuration from '../../config/configuration';
import { ORDER_CONSUMED_QUEUES } from './order-events.routes';

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
  // Required even with one queue: `api-events` is the api's, and its inbox is not in this database.
  const selected = ORDER_CONSUMED_QUEUES.find(({ name }) => name === queueArg);
  if (!selected) {
    const valid = ORDER_CONSUMED_QUEUES.map(({ name }) => name).join(', ');
    throw new Error(`--queue must be one of: ${valid}${queueArg === undefined ? '' : ` (got "${queueArg}")`}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
  }

  // Read from THIS process's environment, which can disagree with the deployment being repaired.
  const { redis, queue, database, retention } = configuration();
  if (!redis.url) throw new Error('REDIS_URL is not set');
  if (!database.url) throw new Error('DATABASE_URL is not set — the inbox check cannot be skipped');

  // maxRetriesPerRequest: null is BullMQ's requirement.
  const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
  const mainQueue = new Queue(selected.name, {
    connection,
    prefix: queue.prefix,
    // Stamped onto the job at add time; without them a replayed message gets no retry budget.
    defaultJobOptions: buildJobOptions(queue.consumerAttempts, queue.consumerBackoffMs),
  });
  // No defaults: nothing consumes a DLQ, so retention rules would delete the record it exists to keep.
  const dlq = new Queue(selected.dlq, { connection, prefix: queue.prefix });

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

    // Printed because the guard is only as good as its match with the deployment's inbox window.
    console.log(
      `\n--- dead-letter replay of ${selected.dlq} (${apply ? 'APPLY' : 'dry run'}, limit ${limit}, ` +
        `inbox window ${retention.inboxDays}d${force ? ', FORCED' : ''}) ---`,
    );
    if (summary.outcomes.length === 0) {
      console.log('dead-letter queue is empty');
    }
    for (const outcome of summary.outcomes) {
      const reason = outcome.failedReason ? ` [parked: ${outcome.failedReason}]` : '';
      const detail = outcome.detail ? ` — ${outcome.detail}` : '';
      console.log(`${outcome.status.padEnd(8)} ${outcome.eventType.padEnd(18)} ${outcome.messageId}${reason}${detail}`);
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
