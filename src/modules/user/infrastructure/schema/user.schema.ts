import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// User/Auth schema (users + refresh-token sessions). Infrastructure, never
// imported by domain. Same conventions as catalog.schema.ts (tz stamps).

// Matches the Role union (src/shared/rbac/role.enum.ts).
export const role = pgEnum('role', ['ADMIN', 'CUSTOMER']);

// No default: every id here carries a routing bucket only the writer can compute, so a fallback
// would mint unroutable rows. Without one, each insert site supplies an id or fails to compile.
const id = () => uuid('id').primaryKey();

// Timezone-aware audit stamps; `updatedAt` bumped app-side on every UPDATE.
const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: role('role').notNull().default('CUSTOMER'),
  // Null until verified, then the verification timestamp (kept as a time, not a boolean).
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // Monotonic session epoch stamped into every access token; a bump (logout-all /
  // change-password) invalidates every token minted under an older epoch at once.
  tokenEpoch: integer('token_epoch').notNull().default(0),
  ...stamps,
});

/** Single-use email-verification tokens — only the SHA-256 hash is stored; `consumedAt` enforces single use. */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_email_verification_tokens_user').on(t.userId),
    // The sweep's predicate is a disjunction — expired OR already spent — and BOTH arms must be
    // indexed or neither is used. Measured on 200k rows: one index alone gave a 22ms parallel seq
    // scan, both give a BitmapOr at ~0.03ms.
    index('idx_email_verification_tokens_expires').on(t.expiresAt),
    // Partial: an unspent token has no consumption date, so those rows can never match this arm.
    index('idx_email_verification_tokens_consumed')
      .on(t.consumedAt)
      .where(sql`${t.consumedAt} is not null`),
  ],
);

/** Single-use password-reset tokens — same shape as email-verification tokens (only the hash is stored). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_password_reset_tokens_user').on(t.userId),
    // Same pair, same reason as the email-verification twin.
    index('idx_password_reset_tokens_expires').on(t.expiresAt),
    index('idx_password_reset_tokens_consumed')
      .on(t.consumedAt)
      .where(sql`${t.consumedAt} is not null`),
  ],
);

/** Stateful refresh tokens, one row per issued token (immediate revoke + rotation lineage) — `tokenHash` = SHA-256, `familyId` groups a login session (a detected reuse revokes the family), `replacedByTokenId` points at the successor. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    replacedByTokenId: uuid('replaced_by_token_id').unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_refresh_tokens_user').on(t.userId),
    index('idx_refresh_tokens_family').on(t.familyId),
    // Two indexes for one sweep, whose predicate is a disjunction: expired WITHOUT ever being
    // revoked, OR revoked long enough ago to stop being a reuse signal. Both partial, each mirroring
    // its own arm exactly. `revoked_at IS NULL` is not just a size trick — rotation revokes every
    // predecessor, so on a mature table a plain `expires_at` index hands the planner a match list
    // that is almost entirely rejects. Measured on 200k rows: plain was a 41ms seq scan, partial is
    // a BitmapOr at 0.09ms with a 152kB index. `listActiveSessions` filters the same way, so it
    // stays usable there.
    index('idx_refresh_tokens_expires')
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} is null`),
    // Mirror image: a live token has no revocation date, so the second arm can only match rows
    // that have one.
    index('idx_refresh_tokens_revoked')
      .on(t.revokedAt)
      .where(sql`${t.revokedAt} is not null`),
  ],
);

/**
 * Fingerprint of the HMAC key the ids above were minted under — written on the first boot against a
 * database, compared on every boot after. Stored here rather than in the environment so it travels
 * with a backup: a restore into an environment holding a different key refuses to boot.
 */
export const identityKeyPin = pgTable(
  'identity_key_pin',
  {
    id: smallint('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One database was built under one key; a second row would mean two answers to which one.
  (t) => [check('ck_identity_key_pin_singleton', sql`${t.id} = 1`)],
);
