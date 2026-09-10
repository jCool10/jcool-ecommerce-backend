import type { Job, Queue } from 'bullmq';
import type { DeadLetterJob } from './dead-letter';
import { envelopeFields, isWellFormedEnvelope, type DomainEventJob } from './domain-event.job';

export interface ReplayOutcome {
  messageId: string;
  eventType: string;
  status: 'replayed' | 'skipped';
  /** Why it was skipped, for the operator reading the summary. */
  detail?: string;
  /** Why the message was parked, straight off the envelope — the diagnosis a replay cannot fix. */
  failedReason?: string;
}

export interface ReplaySummary {
  replayed: number;
  skipped: number;
  outcomes: ReplayOutcome[];
}

/** When the domain-events consumer applied this message, or null if it never did. */
export type InboxClaimLookup = (messageId: string) => Promise<Date | null>;

export interface ReplayOptions {
  limit?: number;
  dryRun?: boolean;
  /** Required, not optional — an optional guard is one that gets forgotten during an incident. */
  inboxLookup: InboxClaimLookup;
  inboxRetentionMs: number;
  /** Overrides the age check ONLY. It can never override an existing claim. */
  force?: boolean;
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
 * Branch 3 keys on `occurredAt`, not `failedAt`: it must establish that IF the message had been
 * applied, its claim would still be here to say so. A consumer transaction cannot begin before the
 * producer committed, so `processed_at >= occurredAt` holds unconditionally. `failedAt` proves
 * nothing of the sort — it is rewritten on every dead-lettering, so a message applied long ago and
 * re-parked today carries a brand-new stamp. It is reported in the refusal but decides nothing.
 *
 * `dryRun` is the default because this puts real traffic on a live queue; the guard runs in dry run
 * too, so the listing shows what would actually be refused.
 */
export async function replayDeadLetters(
  main: Queue,
  dlq: Queue,
  { limit = 100, dryRun = true, inboxLookup, inboxRetentionMs, force = false }: ReplayOptions,
): Promise<ReplaySummary> {
  // Nothing consumes the DLQ, so every job it holds is waiting.
  const jobs = await dlq.getJobs(['waiting', 'prioritized'], 0, limit - 1, true);
  const outcomes: ReplayOutcome[] = [];

  for (const job of jobs as Job<DeadLetterJob>[]) {
    // Per job, never per batch: one unreadable entry must not cost the record of which others went back.
    try {
      outcomes.push(await replayOne(main, dlq, job, { dryRun, inboxLookup, inboxRetentionMs, force }));
    } catch (error) {
      outcomes.push({
        messageId: job.data?.outboxId ?? job.id ?? 'unknown',
        eventType: job.data?.eventType ?? 'unknown',
        status: 'skipped',
        detail: error instanceof Error ? error.message : String(error),
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
  main: Queue,
  dlq: Queue,
  job: Job<DeadLetterJob>,
  { dryRun, inboxLookup, inboxRetentionMs, force }: Required<Omit<ReplayOptions, 'limit'>>,
): Promise<ReplayOutcome> {
  // The DLQ is where malformed envelopes are parked, so its contents must not be trusted to match
  // their type. Both fields below are used as keys further down.
  if (!isWellFormedEnvelope(job.data)) {
    return {
      messageId: job.id ?? 'unknown',
      eventType: 'unknown',
      status: 'skipped',
      detail: `malformed envelope, not replayable (fields: ${envelopeFields(job.data)}) — inspect and delete it by hand`,
    };
  }

  const messageId = job.data.outboxId;
  const outcome: ReplayOutcome = {
    messageId,
    eventType: job.data.eventType,
    status: 'skipped',
    failedReason: job.data.failedReason,
  };

  // Branch 1. Not overridable: a claim means the effect already happened.
  const appliedAt = await inboxLookup(messageId);
  if (appliedAt) {
    outcome.detail = `already applied at ${appliedAt.toISOString()} — a replay would be a silent no-op (--force cannot override this)`;
    return outcome;
  }

  // An unparseable stamp counts as born before the window: `isWellFormedEnvelope` does not vet this
  // field, and an unprovable replay is refused rather than attempted.
  const occurredAtMs = Date.parse(job.data.occurredAt);
  const olderThanRetention = !Number.isFinite(occurredAtMs) || Date.now() - occurredAtMs > inboxRetentionMs;
  if (olderThanRetention && !force) {
    outcome.detail =
      `occurred ${job.data.occurredAt} (last failed ${job.data.failedAt}), older than the ` +
      `${Math.round(inboxRetentionMs / 86_400_000)}-day inbox retention — a claim from back then would ` +
      `already have been swept, so "no claim" cannot be told apart from "applied and forgotten" and ` +
      `replaying may apply the effect twice. Re-run with --force if you have confirmed it was never applied`;
    return outcome;
  }

  if (dryRun) {
    outcome.detail = force && olderThanRetention ? 'dry run (would be forced past the retention horizon)' : 'dry run';
    return outcome;
  }

  // The failed job still holds this id in the main queue (kept for a week), and `add` with an
  // existing jobId is ignored rather than rejected — without this the replay is a silent no-op.
  const stale = await main.getJob(messageId);
  if (stale) {
    try {
      await stale.remove();
    } catch (error) {
      // A locked job is one a worker is running right now; removing it underneath must not happen.
      outcome.detail = `main-queue job still held: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }
  }

  const { failedReason: _reason, attemptsMade: _attempts, failedAt: _at, ...envelope } = job.data;
  await main.add(envelope.eventType, envelope satisfies DomainEventJob, { jobId: messageId });

  // Only after the re-publish landed — the reverse order would lose the message outright. Re-read
  // rather than reuse the handle: if it poisoned again meanwhile, the router has replaced this entry
  // with a fresher diagnosis and deleting that would hide the failure.
  const current = (await dlq.getJob(messageId)) as Job<DeadLetterJob> | undefined;
  if (current && current.data?.failedAt === job.data.failedAt) await current.remove();

  outcome.status = 'replayed';
  return outcome;
}
