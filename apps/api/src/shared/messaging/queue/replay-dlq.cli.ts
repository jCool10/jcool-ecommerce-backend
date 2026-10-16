/**
 * Send dead letters back to the retry poller:
 *   npm run queue:replay-dlq                              # list what would be replayed, change nothing
 *   npm run queue:replay-dlq -- --apply                   # actually replay
 *   npm run queue:replay-dlq -- --apply --limit 20 --consumer domain-events
 *   npm run queue:replay-dlq -- --apply --force           # past the retention horizon; it can never
 *                                                        # override a claim that is actually there
 * In a deployed container (no devDependencies, so no `tsx`), the compiled twin:
 *   npm run queue:replay-dlq:prod -- --apply
 *
 * A replay cannot fix the reason the message failed — read the printed reason and deploy the fix
 * first, or the same messages come straight back.
 *
 * Runs standalone rather than booting Nest, since a replay happens while the app is what is broken.
 * Needs Postgres only; a revived row is delivered by the poller of a running app. Lives under `src/`
 * because `scripts/` is excluded from the build and `tsx` is a devDependency.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import configuration from '@shared/config/configuration';
import * as schema from '@shared/infrastructure/database/schema';
import { inboxClaimLookup } from '../inbox/inbox-claim.lookup';
import { ConsumerRetryStore } from '../retry/consumer-retry.store';
import { replayDeadLetters } from './dead-letter.replay';

const DAY_MS = 86_400_000;

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg === -1 ? 100 : Number(process.argv[limitArg + 1]);
const consumerArg = process.argv.indexOf('--consumer');
const consumer = consumerArg === -1 ? undefined : process.argv[consumerArg + 1];

async function main(): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${process.argv[limitArg + 1]}"`);
  }
  if (consumerArg !== -1 && (!consumer || consumer.startsWith('--'))) {
    throw new Error('--consumer needs a consumer name');
  }

  // Read from THIS process's environment, so the inbox it checks and the retention window can silently
  // disagree with the deployment being repaired. Only the window is echoed below.
  const { database, retention } = configuration();
  if (!database.url) throw new Error('DATABASE_URL is not set — the inbox check cannot be skipped');

  // One connection: this reads at most `limit` rows, one at a time, and then exits.
  const pool = new Pool({ connectionString: database.url, max: 1 });
  const db = drizzle(pool, { schema });

  try {
    const summary = await replayDeadLetters(new ConsumerRetryStore(db), {
      limit,
      dryRun: !apply,
      inboxLookup: inboxClaimLookup(db),
      inboxRetentionMs: retention.inboxDays * DAY_MS,
      force,
      consumer,
    });

    console.log(
      `\n--- dead-letter replay (${apply ? 'APPLY' : 'dry run'}, limit ${limit}, ` +
        `consumer ${consumer ?? 'all'}, inbox window ${retention.inboxDays}d${force ? ', FORCED' : ''}) ---`,
    );
    if (summary.outcomes.length === 0) {
      console.log('no dead letters');
    }
    for (const outcome of summary.outcomes) {
      // Labelled because on a `replayed` line an unlabelled reason reads as a failure that just happened.
      const reason = outcome.failedReason ? ` [parked: ${outcome.failedReason}]` : '';
      const detail = outcome.detail ? ` — ${outcome.detail}` : '';
      console.log(
        `${outcome.status.padEnd(8)} ${outcome.consumer.padEnd(14)} ${outcome.eventType.padEnd(16)} ` +
          `${outcome.messageId}${reason}${detail}`,
      );
    }
    console.log(`\nreplayed: ${summary.replayed}   skipped: ${summary.skipped}`);
    if (!apply && summary.outcomes.length > 0) {
      console.log('re-run with --apply to replay these messages');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
