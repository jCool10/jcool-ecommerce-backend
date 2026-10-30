import { Inject, Injectable } from '@nestjs/common';
import { type IdMinter, mintOne } from '../messaging.options';
import { MESSAGING_ID_GENERATOR } from '../messaging.tokens';
import type { OutboxTx } from '../outbox-port';
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
  constructor(@Inject(MESSAGING_ID_GENERATOR) private readonly idGenerator: IdMinter) {}

  /**
   * True when this delivery won the row and owns the effect. Two concurrent deliveries do not race:
   * the loser BLOCKS on the unique index until the winner's transaction ends, then either sees the
   * committed row and returns false, or — if the winner rolled back — takes the row itself.
   */
  async claim(tx: OutboxTx, entry: InboxEntry): Promise<boolean> {
    const claimed = await tx
      .insert(inbox)
      .values({ id: await mintOne(this.idGenerator), ...entry })
      .onConflictDoNothing({ target: [inbox.consumer, inbox.messageId] })
      .returning({ id: inbox.id });

    return claimed.length > 0;
  }
}
