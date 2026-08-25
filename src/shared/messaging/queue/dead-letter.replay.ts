import type { Job, Queue } from 'bullmq';
import type { DeadLetterJob } from './dead-letter';
import { envelopeFields, isWellFormedEnvelope, type DomainEventJob } from './domain-event.job';

export interface ReplayOutcome {
  messageId: string;
  eventType: string;
  status: 'replayed' | 'skipped';
  /** Why it was skipped, for the operator reading the summary. */
  detail?: string;
}

export interface ReplaySummary {
  replayed: number;
  skipped: number;
  outcomes: ReplayOutcome[];
}

/**
 * The way back out of the dead-letter queue: re-publish the message to `domain-events` and drop the
 * dead-letter copy.
 *
 * Safe to run against a message that was in fact already applied — the id it is re-published under
 * is the outbox row id, which is what the inbox dedups on, so a needless replay costs one collapsed
 * duplicate and nothing else.
 *
 * `dryRun` is the default because this puts real traffic back on a live queue.
 */
export async function replayDeadLetters(
  main: Queue,
  dlq: Queue,
  { limit = 100, dryRun = true }: { limit?: number; dryRun?: boolean } = {},
): Promise<ReplaySummary> {
  // Nothing consumes the DLQ, so every job it holds is waiting; `prioritized` is only reachable if
  // someone adds one with a priority, which nothing here does.
  const jobs = await dlq.getJobs(['waiting', 'prioritized'], 0, limit - 1, true);
  const outcomes: ReplayOutcome[] = [];

  for (const job of jobs as Job<DeadLetterJob>[]) {
    // Per job, never per batch: this runs during an incident, and one unreadable entry out of a
    // hundred must not cost the operator the record of which of the other ninety-nine went back.
    try {
      outcomes.push(await replayOne(main, dlq, job, dryRun));
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

async function replayOne(main: Queue, dlq: Queue, job: Job<DeadLetterJob>, dryRun: boolean): Promise<ReplayOutcome> {
  // The DLQ is where malformed envelopes are sent to be looked at, so its contents are the one place
  // that must not be trusted to match its type. Both fields below are used as keys further down.
  if (!isWellFormedEnvelope(job.data)) {
    return {
      messageId: job.id ?? 'unknown',
      eventType: 'unknown',
      status: 'skipped',
      detail: `malformed envelope, not replayable (fields: ${envelopeFields(job.data)}) — inspect and delete it by hand`,
    };
  }

  const messageId = job.data.outboxId;
  const outcome: ReplayOutcome = { messageId, eventType: job.data.eventType, status: 'skipped' };

  if (dryRun) {
    outcome.detail = 'dry run';
    return outcome;
  }

  // The step that is easy to leave out and silently turns the whole replay into a no-op: the failed
  // job still holds this id in the main queue (kept for a week), and `add` with a jobId that already
  // exists is ignored rather than rejected. Clear the id before reusing it.
  const stale = await main.getJob(messageId);
  if (stale) {
    try {
      await stale.remove();
    } catch (error) {
      // A locked job is one a worker is running right now — it is being retried on its own, and
      // removing it underneath the worker is exactly what must not happen.
      outcome.detail = `main-queue job still held: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }
  }

  const { failedReason: _reason, attemptsMade: _attempts, failedAt: _at, ...envelope } = job.data;
  await main.add(envelope.eventType, envelope satisfies DomainEventJob, { jobId: messageId });

  // Only after the re-publish landed: crashing between the two leaves a dead-letter copy that a
  // rerun collapses on the inbox, whereas the reverse order would lose the message outright.
  //
  // Re-read instead of removing the handle already in hand. If the replayed message poisoned again
  // in the meantime, the router has replaced this entry with a fresher diagnosis, and deleting that
  // would hide the failure in the queue whose entire job is to show it.
  const current = (await dlq.getJob(messageId)) as Job<DeadLetterJob> | undefined;
  if (current && current.data?.failedAt === job.data.failedAt) await current.remove();

  outcome.status = 'replayed';
  return outcome;
}
