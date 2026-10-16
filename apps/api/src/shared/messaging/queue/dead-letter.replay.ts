import { toError } from '@jcool/kernel';
import type { ConsumerRetryRow, ConsumerRetryStore } from '../retry/consumer-retry.store';
import { envelopeFields, isWellFormedEnvelope } from './domain-event.job';

export type DeadLetterStore = Pick<ConsumerRetryStore, 'listDead' | 'revive'>;

export interface ReplayOutcome {
  consumer: string;
  messageId: string;
  eventType: string;
  status: 'replayed' | 'skipped';
  /** Why it was skipped, for the operator reading the summary. */
  detail?: string;
  /** The last error the row recorded — the diagnosis a replay cannot fix. */
  failedReason?: string;
}

export interface ReplaySummary {
  replayed: number;
  skipped: number;
  outcomes: ReplayOutcome[];
}

/** When the consumer applied this message, or null if it never did. */
export type InboxClaimLookup = (consumer: string, messageId: string) => Promise<Date | null>;

export interface ReplayOptions {
  limit?: number;
  dryRun?: boolean;
  /** Required, not optional — an optional guard is one that gets forgotten during an incident. */
  inboxLookup: InboxClaimLookup;
  inboxRetentionMs: number;
  /** Overrides the age check ONLY. It can never override an existing claim. */
  force?: boolean;
  consumer?: string;
}

/**
 * Once inbox claims are swept, "no claim" no longer distinguishes "never applied" from "applied and
 * forgotten", so the inbox decides in three branches:
 *
 * | inbox claim | decision |
 * |---|---|
 * | present | refuse, even with `--force` — a replay would be a silent no-op read as a fix |
 * | absent, born inside the retention window | replay |
 * | absent, born before the window | refuse unless `--force` — the claim may just have been swept |
 *
 * Branch 3 keys on the envelope's `occurredAt`: a consumer transaction cannot begin before the
 * producer committed, so `processed_at >= occurredAt` always holds. `last_failed_at` proves nothing
 * of the sort and is only printed.
 *
 * A replay revives the row and the poller delivers it; nothing is published here.
 */
export async function replayDeadLetters(
  store: DeadLetterStore,
  { limit = 100, dryRun = true, inboxLookup, inboxRetentionMs, force = false, consumer }: ReplayOptions,
): Promise<ReplaySummary> {
  const rows = await store.listDead({ limit, consumer });
  const outcomes: ReplayOutcome[] = [];

  for (const row of rows) {
    // Per row, never per batch: one failure must not cost the record of which others went back.
    try {
      outcomes.push(await replayOne(store, row, { dryRun, inboxLookup, inboxRetentionMs, force }));
    } catch (error) {
      outcomes.push({
        consumer: row.consumer,
        messageId: row.messageId,
        eventType: row.eventType || 'unknown',
        status: 'skipped',
        detail: toError(error).message,
      });
    }
  }

  return {
    replayed: outcomes.filter((o) => o.status === 'replayed').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    outcomes,
  };
}

async function replayOne(
  store: DeadLetterStore,
  row: ConsumerRetryRow,
  { dryRun, inboxLookup, inboxRetentionMs, force }: Required<Omit<ReplayOptions, 'limit' | 'consumer'>>,
): Promise<ReplayOutcome> {
  const { consumer, messageId, envelope } = row;
  const outcome: ReplayOutcome = {
    consumer,
    messageId,
    eventType: 'unknown',
    status: 'skipped',
    failedReason: row.lastError,
  };
  // Dead rows are where malformed envelopes end up, so the stored envelope is not trusted to match its type.
  if (!isWellFormedEnvelope(envelope)) {
    outcome.detail = `malformed envelope, not replayable (fields: ${envelopeFields(envelope)}) — inspect and delete it by hand`;
    return outcome;
  }
  outcome.eventType = envelope.eventType;

  const appliedAt = await inboxLookup(consumer, messageId);
  if (appliedAt) {
    outcome.detail = `already applied at ${appliedAt.toISOString()} — a replay would be a silent no-op (--force cannot override this)`;
    return outcome;
  }

  // An unparseable stamp counts as born before the window: an unprovable replay is refused.
  const occurredAtMs = Date.parse(envelope.occurredAt);
  const olderThanRetention = !Number.isFinite(occurredAtMs) || Date.now() - occurredAtMs > inboxRetentionMs;
  if (olderThanRetention && !force) {
    outcome.detail =
      `occurred ${envelope.occurredAt} (last failed ${row.lastFailedAt.toISOString()}), older than the ` +
      `${Math.round(inboxRetentionMs / 86_400_000)}-day inbox retention — a claim from back then would ` +
      `already have been swept, so "no claim" cannot be told apart from "applied and forgotten" and ` +
      `replaying may apply the effect twice. Re-run with --force if you have confirmed it was never applied`;
    return outcome;
  }

  if (dryRun) {
    outcome.detail = force && olderThanRetention ? 'dry run (would be forced past the retention horizon)' : 'dry run';
    return outcome;
  }

  if (!(await store.revive({ consumer, messageId }))) {
    outcome.detail = 'no longer dead — revived or removed since it was listed';
    return outcome;
  }
  outcome.status = 'replayed';
  return outcome;
}
