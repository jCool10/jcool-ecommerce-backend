import { Logger, type Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { count, isNull, sql } from 'drizzle-orm';
import type { Gauge } from 'prom-client';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { outbox } from '@shared/messaging/outbox/schema/outbox.schema';

// Only the pair is diagnostic. A count alone cannot tell a burst the relay is already draining from
// a relay that died — on a quiet shop a dead relay barely moves it. An age alone cannot tell one
// wedged row from a flooded table. Alert on the age; size the incident by the count.
export const OUTBOX_BACKLOG_PENDING = 'outbox_backlog_pending';
export const OUTBOX_OLDEST_AGE_SECONDS = 'outbox_oldest_age_seconds';

// `connectionTimeoutMillis` bounds getting a client, nothing after it. A statement blocked on an
// ACCESS EXCLUSIVE lock (a migration, VACUUM FULL) would otherwise hang the scrape forever while
// holding one of the pool's clients — and /metrics is scraped on a schedule, so that is one client
// lost per interval until the pool is empty. Give up early instead; a stale gauge beats a dead pool.
const SCRAPE_TIMEOUT_MS = 2_000;

const logger = new Logger('OutboxBacklogCollector');

interface OutboxBacklog {
  pending: number;
  oldestAgeSeconds: number;
}

interface PendingRead {
  backlog: Promise<OutboxBacklog>;
  reported: boolean;
}

// prom-client starts every collect() of a scrape before awaiting any of them, so the two gauges
// would otherwise run the same query twice. Sharing the in-flight read collapses them into one query
// per scrape and caches nothing between reads: what a gauge reports always comes from a query that
// was still running when its collect() started. Two overlapping scrapes do share one read, so the
// second reports a snapshot up to one query old — a real bound, not a stored value.
let pending: PendingRead | null = null;

function readBacklog(db: DrizzleDB): Promise<OutboxBacklog | null> {
  const read = (pending ??= {
    // Cleared when the query settles, not when a caller gives up on it: a statement stuck behind a
    // lock keeps this slot, so later scrapes time out against the same query instead of checking out
    // one more client every interval.
    backlog: queryBacklog(db).finally(() => {
      pending = null;
    }),
    reported: false,
  });

  return bounded(read);
}

// Resolves to null on any failure — a scrape awaits every collect(), so one rejection here would fail
// the WHOLE /metrics response, and every unrelated series would go dark at exactly the moment the
// database is unreachable, which is when they are needed most. Hold the last value instead: the
// database has its own health signal, and a backlog gauge frozen at its last reading is the lesser lie.
async function bounded(read: PendingRead): Promise<OutboxBacklog | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      read.backlog,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`query exceeded ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
        // An in-flight scrape must never be the reason the process refuses to exit.
        timer.unref?.();
      }),
    ]);
  } catch (caught) {
    // One line per failed read, not one per gauge: both gauges are awaiting this same query, and a
    // database outage lasts many scrapes.
    if (!read.reported) {
      read.reported = true;
      logger.warn(`outbox backlog scrape failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryBacklog(db: DrizzleDB): Promise<OutboxBacklog> {
  const [row] = await db
    .select({
      pending: count(),
      // Aged against the DATABASE clock, so a container with a skewed clock cannot invent a backlog
      // or hide one. COALESCE turns "no unpublished row" into 0 rather than a NULL that would blank
      // the series — and a blank series is not something an alert rule can fire on.
      oldestAgeSeconds: sql<string>`coalesce(extract(epoch from now() - min(${outbox.createdAt})), 0)`,
    })
    .from(outbox)
    // Matches the partial index `idx_outbox_unpublished`, so both aggregates stay a scan of the
    // backlog rather than of every event the system has ever emitted.
    .where(isNull(outbox.publishedAt));

  // pg returns `numeric` as a string (it has no lossless JS counterpart); the age is seconds and
  // safely within a double.
  return { pending: row.pending, oldestAgeSeconds: Number(row.oldestAgeSeconds) };
}

async function observe(gauge: Gauge<string>, db: DrizzleDB, pick: (backlog: OutboxBacklog) => number): Promise<void> {
  const backlog = await readBacklog(db);
  if (backlog) gauge.set(pick(backlog));
}

// The registry is keyed by metric name and get-or-creates, so a second Nest app in the same process
// reuses these gauges and its injected `db` is discarded — the collect closure keeps the first app's
// pool for the life of the process. One app per process in production; in tests it means a suite that
// closes the registering app and then scrapes from a second one reads through a pool that is already
// ended, which the fail-open above turns into a frozen gauge rather than a failure. Vitest isolates
// each e2e file, so this is bounded to a single file building two apps against the same database.
export const OUTBOX_BACKLOG_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: OUTBOX_BACKLOG_PENDING,
    help: 'Outbox rows the relay has not published yet.',
    inject: [DRIZZLE],
    collect(this: Gauge<string>, db: DrizzleDB) {
      return observe(this, db, (backlog) => backlog.pending);
    },
  }),
  makeGaugeProvider({
    name: OUTBOX_OLDEST_AGE_SECONDS,
    help: 'Age of the oldest unpublished outbox row in seconds (0 when nothing is pending).',
    inject: [DRIZZLE],
    collect(this: Gauge<string>, db: DrizzleDB) {
      return observe(this, db, (backlog) => backlog.oldestAgeSeconds);
    },
  }),
];
