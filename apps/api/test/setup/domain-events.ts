import type { INestApplication } from '@nestjs/common';
import { count, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { outbox } from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { AppliedResult } from '../../src/shared/messaging/queue/domain-event.processor';
import { deliverApplied } from './domain-event-transport';

const RELAY_BATCH = 100;

export interface DrainedEvent {
  eventType: string;
  outboxId: string;
  result: AppliedResult;
}

/**
 * What the relay and the consumers do unattended, run in the foreground: relay, then deliver every
 * message published since the last read, until a pass finds nothing. A delivery that did not apply
 * fails the drain, so a broken consume can never pass for a converged one.
 */
export async function drainDomainEvents(
  app: INestApplication,
  { maxPasses = 3 }: { maxPasses?: number } = {},
): Promise<DrainedEvent[]> {
  const relay = app.get(OutboxRelay);
  const db = app.get<DrizzleDB>(DRIZZLE);
  const drained: DrainedEvent[] = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const relayed = await relay.runOnce(RELAY_BATCH);
    if (relayed.failed > 0) throw new Error(`relay refused ${relayed.failed} outbox rows`);

    const delivered = await deliverApplied(app);
    if (delivered.length === 0) {
      // The relay skips its tick while the publisher is not ready, which looks exactly like an empty outbox.
      const [{ unpublished }] = await db
        .select({ unpublished: count() })
        .from(outbox)
        .where(isNull(outbox.publishedAt));
      if (unpublished > 0) throw new Error(`${unpublished} outbox rows were never relayed`);
      return drained;
    }

    for (const { eventType, outboxId, result } of delivered) {
      drained.push({ eventType: eventType!, outboxId: outboxId!, result: result as AppliedResult });
    }
  }
  throw new Error(`domain events still published after ${maxPasses} passes`);
}
