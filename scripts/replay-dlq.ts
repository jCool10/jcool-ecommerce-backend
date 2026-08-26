/**
 * Drain the domain-events dead-letter queue back onto the main queue:
 *   npx tsx scripts/replay-dlq.ts                 # list what would be replayed, change nothing
 *   npx tsx scripts/replay-dlq.ts --apply         # actually replay
 *   npx tsx scripts/replay-dlq.ts --apply --limit 20
 *
 * Replaying is safe for a message that turned out to have been applied after all: it goes back
 * under the outbox row id, which is the key the inbox dedups on, so the worst case is one collapsed
 * duplicate. What it cannot fix is the reason the message failed — check the printed `failedReason`
 * and deploy the fix first, or the same messages come straight back.
 *
 * Runs standalone rather than booting Nest: it only needs Redis, and a replay is something you want
 * to be able to do while the app itself is the thing that is broken.
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import configuration from '../src/shared/config/configuration';
import { replayDeadLetters } from '../src/shared/messaging/queue/dead-letter.replay';
import { QUEUE_DOMAIN_EVENTS, QUEUE_DOMAIN_EVENTS_DLQ } from '../src/shared/messaging/queue/queue.constants';

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg === -1 ? 100 : Number(process.argv[limitArg + 1]);

async function main(): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${process.argv[limitArg + 1]}"`);
  }

  // Through the app's own config factory, not re-read from env: a tool that guessed a different
  // prefix than the app writes under would report a reassuringly empty queue.
  const { redis, queue } = configuration();
  if (!redis.url) throw new Error('REDIS_URL is not set');
  const prefix = queue.prefix;

  // maxRetriesPerRequest: null is BullMQ's requirement, not a preference — it refuses to build on a
  // connection with a finite budget.
  const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
  const domainEvents = new Queue(QUEUE_DOMAIN_EVENTS, { connection, prefix });
  const dlq = new Queue(QUEUE_DOMAIN_EVENTS_DLQ, { connection, prefix });

  try {
    const summary = await replayDeadLetters(domainEvents, dlq, { limit, dryRun: !apply });

    console.log(`\n--- dead-letter replay (${apply ? 'APPLY' : 'dry run'}, limit ${limit}) ---`);
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
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
