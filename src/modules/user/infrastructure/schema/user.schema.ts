import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// User/Auth schema (users + refresh-token sessions). Infrastructure, never
// imported by domain. Same conventions as catalog.schema.ts (UUID v7 ids, tz stamps).

// Matches the Role union (src/shared/rbac/role.enum.ts).
export const role = pgEnum('role', ['ADMIN', 'CUSTOMER']);

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

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
  (t) => [index('idx_email_verification_tokens_user').on(t.userId)],
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
  (t) => [index('idx_password_reset_tokens_user').on(t.userId)],
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
  (t) => [index('idx_refresh_tokens_user').on(t.userId), index('idx_refresh_tokens_family').on(t.familyId)],
);
