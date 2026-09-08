import { sql } from 'drizzle-orm';
import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Infrastructure, never imported by domain. No FK to products: the reference points the other way,
// and cross-context FKs are not used here.

export const mediaAssetStatus = pgEnum('media_asset_status', ['PENDING', 'READY', 'ATTACHED', 'DETACHED', 'SWEEPING']);

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    // Unique because it is the object's identity in the bucket: two rows on one key would let a
    // sweep of either delete the bytes the other still points at.
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    // bigint: an object's size can exceed a 32-bit integer even where policy would refuse it, and
    // the value comes from the bucket rather than from us.
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    status: mediaAssetStatus('status').notNull().default('PENDING'),
    uploadedBy: uuid('uploaded_by').notNull(),
    // Null only for ATTACHED. Every other state must stay selectable by the sweep's predicate.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...stamps,
  },
  (t) => [
    // Partial, so it stays proportional to what is reclaimable rather than to every asset uploaded.
    index('idx_media_assets_reclaimable_expires_at')
      .on(t.expiresAt)
      .where(sql`${t.status} in ('PENDING', 'READY', 'DETACHED')`),
    // The other half of the sweep's queue: a claimed row has no expiry to sort by, and a crash
    // mid-claim leaves one behind to be found again.
    index('idx_media_assets_sweeping_updated_at')
      .on(t.updatedAt)
      .where(sql`${t.status} = 'SWEEPING'`),
  ],
);
