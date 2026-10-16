import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { InboxClaimLookup } from '../queue/dead-letter.replay';
import { inbox } from './schema/inbox.schema';

export const inboxClaimLookup =
  (db: DrizzleDB): InboxClaimLookup =>
  async (consumer, messageId) => {
    const [row] = await db
      .select({ processedAt: inbox.processedAt })
      .from(inbox)
      .where(and(eq(inbox.consumer, consumer), eq(inbox.messageId, messageId)))
      .limit(1);
    return row?.processedAt ?? null;
  };
