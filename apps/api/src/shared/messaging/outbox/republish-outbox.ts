import { parseArgs } from 'node:util';
import { and, count, eq, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { inbox } from '../inbox/schema/inbox.schema';
import { outbox } from './schema/outbox.schema';

const DAY_MS = 86_400_000;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: DAY_MS } as const;

export interface RepublishWindow {
  sinceMs: number;
  /** Empty selects every event type. */
  eventTypes: readonly string[];
}

export interface RepublishRetention {
  inboxDays: number;
  outboxDays: number;
}

export interface EventTypeCount {
  eventType: string;
  rows: number;
}

export interface ConsumerClaimCount {
  consumer: string;
  rows: number;
}

export interface RepublishReport {
  byEventType: EventTypeCount[];
  /** Rows a consumer already applied: the copies its inbox is expected to swallow. */
  claimsByConsumer: ConsumerClaimCount[];
  reset: number;
}

export interface OutboxWindowStore {
  countByEventType(window: RepublishWindow): Promise<EventTypeCount[]>;
  countClaimsByConsumer(window: RepublishWindow): Promise<ConsumerClaimCount[]>;
  resetPublished(window: RepublishWindow): Promise<number>;
}

export function parseSince(value: string): number {
  const match = /^([1-9]\d*)([mhd])$/.exec(value);
  if (!match) throw new Error(`--since takes a whole number with a unit (m, h or d), got "${value}"`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Strict on purpose: a mistyped `--event-type` must not fall through to republishing every type. */
export function parseRepublishArgs(argv: string[]): { window: RepublishWindow; apply: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      'event-type': { type: 'string', multiple: true },
      apply: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.since === undefined) throw new Error('--since is required, e.g. --since 2h');

  const named = values['event-type'] ?? [];
  const eventTypes = [...new Set(named.flatMap((value) => value.split(',')).map((type) => type.trim()))];
  if (eventTypes.some((type) => type === '')) {
    throw new Error('--event-type takes a non-empty event type or a comma-separated list of them');
  }

  return { window: { sinceMs: parseSince(values.since), eventTypes }, apply: values.apply };
}

/**
 * Puts a window of published outbox rows back in front of the relay, so every consumer gets them
 * again and its inbox swallows the ones it already applied.
 */
export async function republishOutbox(
  store: OutboxWindowStore,
  { window, dryRun, retention }: { window: RepublishWindow; dryRun: boolean; retention: RepublishRetention },
): Promise<RepublishReport> {
  assertWithinRetention(window.sinceMs, retention);

  const byEventType = await store.countByEventType(window);
  const claimsByConsumer = await store.countClaimsByConsumer(window);
  const reset = dryRun ? 0 : await store.resetPublished(window);
  return { byEventType, claimsByConsumer, reset };
}

function assertWithinRetention(sinceMs: number, { inboxDays, outboxDays }: RepublishRetention): void {
  // A row older than the inbox window may have lost its claim, so redelivering it could apply it twice.
  if (sinceMs >= inboxDays * DAY_MS) {
    throw new Error(`--since must be shorter than RETENTION_INBOX_DAYS (${inboxDays}d)`);
  }
  if (sinceMs > outboxDays * DAY_MS) {
    throw new Error(`--since must not exceed RETENTION_OUTBOX_DAYS (${outboxDays}d): older rows are already swept`);
  }
}

/**
 * The window is on `created_at`, not `published_at`: a republish rewrites `published_at`, and inbox
 * claims are swept by `processed_at`, which is never earlier than `created_at`.
 */
export class DrizzleOutboxWindowStore implements OutboxWindowStore {
  constructor(private readonly db: DrizzleDB) {}

  async countByEventType(window: RepublishWindow): Promise<EventTypeCount[]> {
    return this.db
      .select({ eventType: outbox.eventType, rows: count() })
      .from(outbox)
      .where(inWindow(window))
      .groupBy(outbox.eventType)
      .orderBy(outbox.eventType);
  }

  async countClaimsByConsumer(window: RepublishWindow): Promise<ConsumerClaimCount[]> {
    return this.db
      .select({ consumer: inbox.consumer, rows: count() })
      .from(outbox)
      .innerJoin(inbox, eq(inbox.messageId, outbox.id))
      .where(inWindow(window))
      .groupBy(inbox.consumer)
      .orderBy(inbox.consumer);
  }

  async resetPublished(window: RepublishWindow): Promise<number> {
    const result = await this.db.update(outbox).set({ publishedAt: null, attempts: 0 }).where(inWindow(window));
    return result.rowCount ?? 0;
  }
}

const inWindow = ({ sinceMs, eventTypes }: RepublishWindow): SQL | undefined =>
  and(
    isNotNull(outbox.publishedAt),
    gte(outbox.createdAt, sql`now() - make_interval(secs => ${sinceMs / 1000})`),
    eventTypes.length > 0 ? inArray(outbox.eventType, [...eventTypes]) : undefined,
  );
