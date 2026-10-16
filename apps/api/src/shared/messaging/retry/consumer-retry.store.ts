import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, lte, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DeadLetterReason } from '@jcool/metrics-port';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { DomainEventJob } from '../queue/domain-event.job';
import { lastErrorText } from './retry-error';
import { consumerRetries } from './schema/consumer-retry.schema';

export type ConsumerRetryRow = typeof consumerRetries.$inferSelect;
export type LeasedRetry = ConsumerRetryRow & { leaseToken: string };
type RetryKey = Pick<ConsumerRetryRow, 'consumer' | 'messageId'>;

export type ParkVerdict = { status: 'pending'; delayMs: number } | { status: 'dead'; reason: DeadLetterReason };

export interface RetryCount {
  consumer: string;
  status: ConsumerRetryRow['status'];
  rows: number;
}

/**
 * Every write after `leaseOne` is a compare-and-set on the lease token: a poller whose lease ran out
 * must not delete or overwrite a row another poller has since taken over.
 */
@Injectable()
export class ConsumerRetryStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** False when the message already has a row, which leaves the ladder already running untouched. */
  park(consumer: string, envelope: DomainEventJob, error: unknown, verdict: ParkVerdict): Promise<boolean> {
    return this.insert(consumer, envelope, error, verdict, 1);
  }

  insertDead(consumer: string, envelope: DomainEventJob, attemptsMade: number, error: unknown): Promise<boolean> {
    return this.insert(consumer, envelope, error, { status: 'dead', reason: 'attempts_exhausted' }, attemptsMade);
  }

  /** The attempt is charged here, at its start, so a process that dies mid-handler still spends it. */
  async leaseOne(leaseMs: number): Promise<LeasedRetry | undefined> {
    const due = this.db
      .select({ consumer: consumerRetries.consumer, messageId: consumerRetries.messageId })
      .from(consumerRetries)
      .where(and(eq(consumerRetries.status, 'pending'), lte(consumerRetries.nextAttemptAt, sql`now()`)))
      .orderBy(asc(consumerRetries.nextAttemptAt))
      .limit(1)
      .for('update', { skipLocked: true });

    const [row] = await this.db
      .update(consumerRetries)
      .set({
        leaseToken: randomUUID(),
        nextAttemptAt: fromNow(leaseMs),
        attemptsMade: sql`${consumerRetries.attemptsMade} + 1`,
      })
      .where(sql`(${consumerRetries.consumer}, ${consumerRetries.messageId}) = ${due}`)
      .returning();
    return row as LeasedRetry | undefined;
  }

  async complete(row: LeasedRetry): Promise<boolean> {
    const deleted = await this.db
      .delete(consumerRetries)
      .where(heldBy(row))
      .returning({ consumer: consumerRetries.consumer });
    return deleted.length > 0;
  }

  reschedule(row: LeasedRetry, delayMs: number, error: unknown): Promise<boolean> {
    return this.release(row, {
      nextAttemptAt: fromNow(delayMs),
      lastError: lastErrorText(error),
      lastFailedAt: sql`now()`,
    });
  }

  /** Without an error when the attempt never ran: the last diagnosis is still the useful one. */
  bury(row: LeasedRetry, reason: DeadLetterReason, error?: unknown): Promise<boolean> {
    return this.release(row, {
      status: 'dead',
      deadReason: reason,
      ...(error === undefined ? {} : { lastError: lastErrorText(error), lastFailedAt: sql`now()` }),
    });
  }

  listDead({ limit, consumer }: { limit: number; consumer?: string }): Promise<ConsumerRetryRow[]> {
    return this.db
      .select()
      .from(consumerRetries)
      .where(and(eq(consumerRetries.status, 'dead'), consumer ? eq(consumerRetries.consumer, consumer) : undefined))
      .orderBy(asc(consumerRetries.createdAt))
      .limit(limit);
  }

  /** Back on the ladder from its first rung; the poller picks it up on its next tick. */
  async revive({ consumer, messageId }: RetryKey): Promise<boolean> {
    const revived = await this.db
      .update(consumerRetries)
      .set({ status: 'pending', attemptsMade: 0, nextAttemptAt: sql`now()`, deadReason: null, leaseToken: null })
      .where(
        and(
          eq(consumerRetries.consumer, consumer),
          eq(consumerRetries.messageId, messageId),
          eq(consumerRetries.status, 'dead'),
        ),
      )
      .returning({ consumer: consumerRetries.consumer });
    return revived.length > 0;
  }

  countByStatus(): Promise<RetryCount[]> {
    return this.db
      .select({ consumer: consumerRetries.consumer, status: consumerRetries.status, rows: count() })
      .from(consumerRetries)
      .groupBy(consumerRetries.consumer, consumerRetries.status);
  }

  private async insert(
    consumer: string,
    envelope: DomainEventJob,
    error: unknown,
    verdict: ParkVerdict,
    attemptsMade: number,
  ): Promise<boolean> {
    const dead = verdict.status === 'dead';
    const inserted = await this.db
      .insert(consumerRetries)
      .values({
        consumer,
        messageId: envelope.outboxId,
        // The envelope is whatever the transport handed over, so a missing type must not become a NOT
        // NULL violation that fails the park on every redelivery.
        eventType: typeof envelope.eventType === 'string' ? envelope.eventType : '',
        envelope,
        attemptsMade,
        status: verdict.status,
        deadReason: dead ? verdict.reason : null,
        nextAttemptAt: dead ? sql`now()` : fromNow(verdict.delayMs),
        lastError: lastErrorText(error),
      })
      .onConflictDoNothing()
      .returning({ consumer: consumerRetries.consumer });
    return inserted.length > 0;
  }

  private async release(row: LeasedRetry, set: PgUpdateSetSource<typeof consumerRetries>): Promise<boolean> {
    const updated = await this.db
      .update(consumerRetries)
      .set({ ...set, leaseToken: null })
      .where(heldBy(row))
      .returning({ consumer: consumerRetries.consumer });
    return updated.length > 0;
  }
}

// Database clock throughout: `leaseOne` compares against `now()`, so an app clock would skew the ladder.
const fromNow = (ms: number): SQL => sql`now() + make_interval(secs => ${ms / 1000})`;

const heldBy = (row: LeasedRetry): SQL | undefined =>
  and(
    eq(consumerRetries.consumer, row.consumer),
    eq(consumerRetries.messageId, row.messageId),
    eq(consumerRetries.leaseToken, row.leaseToken),
  );
