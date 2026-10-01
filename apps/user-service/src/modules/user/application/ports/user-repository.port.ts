import type { NormalizedEmail } from '@jcool/kernel';
import type { DrizzleTx } from '../../../../database';
import type { Role } from '@jcool/platform/rbac';
import type { User } from '../../domain/entities/user.entity';

// Application must not import drizzle-orm/schema; the adapter lives in infrastructure/.
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserInput {
  /**
   * Branded: these exact bytes are stored under the unique index, so a raw `string` here is a compile
   * error rather than a second account under a different case.
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
