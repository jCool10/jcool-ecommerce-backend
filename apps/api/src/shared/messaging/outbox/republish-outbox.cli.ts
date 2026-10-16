/**
 * Hand a window of published outbox rows back to the relay, so every consumer receives them again:
 *   npm run messaging:republish -- --since 2h                                 # counts only, changes nothing
 *   npm run messaging:republish -- --since 90m --event-type order.paid,order.expired --apply
 * In a deployed container, the compiled twin:
 *   npm run messaging:republish:prod -- --since 2h --apply
 *
 * The window is on `created_at` and must stay inside the inbox retention: the inbox is what swallows
 * the rows a consumer already applied. Read the claim counts of the dry run before applying.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import configuration from '@shared/config/configuration';
import * as schema from '@shared/infrastructure/database/schema';
import { DrizzleOutboxWindowStore, parseRepublishArgs, republishOutbox } from './republish-outbox';

async function main(): Promise<void> {
  const { window, apply } = parseRepublishArgs(process.argv.slice(2));
  const { database, retention } = configuration();
  if (!database.url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: database.url, max: 1 });
  try {
    const report = await republishOutbox(new DrizzleOutboxWindowStore(drizzle(pool, { schema })), {
      window,
      dryRun: !apply,
      retention,
    });

    const types = window.eventTypes.length > 0 ? window.eventTypes.join(',') : 'all';
    console.log(
      `\n--- outbox republish (${apply ? 'APPLY' : 'dry run'}, last ${window.sinceMs / 60_000}m by created_at, ` +
        `event types ${types}, inbox window ${retention.inboxDays}d) ---`,
    );
    if (report.byEventType.length === 0) console.log('no published rows in the window');
    for (const { eventType, rows } of report.byEventType) console.log(`rows     ${eventType.padEnd(28)} ${rows}`);
    for (const { consumer, rows } of report.claimsByConsumer) {
      console.log(`claimed  ${consumer.padEnd(28)} ${rows}   (already applied; its inbox swallows these)`);
    }

    if (apply) console.log(`\nreset: ${report.reset} rows, the relay publishes them on its next ticks`);
    else if (report.byEventType.length > 0) console.log('\nre-run with --apply to republish these rows');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
