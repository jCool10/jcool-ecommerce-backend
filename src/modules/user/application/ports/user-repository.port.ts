// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { NormalizedEmail } from '@shared/kernel';
import type { Role } from '@shared/rbac';
import type { User } from '../../domain/entities/user.entity';

// Application must not import drizzle-orm/schema; the adapter lives in infrastructure/.
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserInput {
  /**
   * Branded: these exact bytes are both stored under the unique index and hashed into the row's
   * routing bucket, so a raw `string` here is a compile error rather than a misrouted row.
   */
  email: NormalizedEmail;
  passwordHash: string;
  /** Omit to accept the DB default (CUSTOMER). */
  role?: Role;
}

export interface UserRepositoryPort {
  findByEmail(email: string): Promise<User | null>;

  /** `tx` joins the caller's unit of work instead of checking out a second pool connection. */
  findById(id: string, tx?: DrizzleTx): Promise<User | null>;

  /**
   * The unique email index serializes concurrent writers: `null` means the email is already taken
   * (the insert hit the unique-index conflict), not that the write failed.
   */
  create(input: CreateUserInput): Promise<User | null>;

  /** Idempotent — a no-op if already set. */
  markEmailVerified(userId: string): Promise<void>;

  updatePassword(userId: string, passwordHash: string): Promise<void>;
}
