import type { NormalizedEmail } from '@shared/kernel';
import type { Role } from '@shared/rbac';
import type { User } from '../../domain/entities/user.entity';

// Port the application depends on; the Drizzle adapter implements it in
// infrastructure/. Application must not import drizzle-orm/schema.
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserInput {
  /** Branded: these exact bytes are both stored under the unique index and hashed into the row's routing bucket, so a raw `string` here is a compile error rather than a misrouted row. */
  email: NormalizedEmail;
  passwordHash: string;
  /** Omit to accept the DB default (CUSTOMER). */
  role?: Role;
}

export interface UserRepositoryPort {
  /** One user by (unique) email; null if none. */
  findByEmail(email: string): Promise<User | null>;

  /** One user by id; null if none. */
  findById(id: string): Promise<User | null>;

  /**
   * Insert a new user, letting the unique email index serialize concurrent
   * writers. Returns the persisted entity (id/timestamps filled), or `null` when
   * the email is already taken (the insert hit the unique-index conflict).
   */
  create(input: CreateUserInput): Promise<User | null>;

  /** Stamp the user's email as verified now. Idempotent (a no-op if already set). */
  markEmailVerified(userId: string): Promise<void>;

  /** Replace the user's stored password hash (password reset / change password). */
  updatePassword(userId: string, passwordHash: string): Promise<void>;
}
