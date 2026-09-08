import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { inbox } from './schema/inbox.schema';

export interface InboxEntry {
  consumer: string;
  /** The outbox row id — stable across every redelivery of the same event. */
  messageId: string;
  eventType: string;
}

/**
 * Writes through the CALLER'S transaction and never opens its own, so claim and effect commit or
 * roll back together: a failed effect takes its claim with it and the redelivery does real work,
 * while a committed effect can never be applied twice.
 */
@Injectable()
export class InboxStore {
  /**
   * True when this delivery won the row and owns the effect. Two concurrent deliveries do not race:
   * the loser BLOCKS on the unique index until the winner's transaction ends, then either sees the
   * committed row and returns false, or — if the winner rolled back — takes the row itself.
   */
  async claim(tx: DrizzleTx, entry: InboxEntry): Promise<boolean> {
    const claimed = await tx
      .insert(inbox)
      .values(entry)
      .onConflictDoNothing({ target: [inbox.consumer, inbox.messageId] })
      .returning({ id: inbox.id });

    return claimed.length > 0;
  }
}
