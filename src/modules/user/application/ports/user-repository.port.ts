import type { Role } from '../../../../shared/rbac/role.enum';
import type { User } from '../../domain/entities/user.entity';

// Port the application depends on; the Drizzle adapter implements it in
// infrastructure/. Application must not import drizzle-orm/schema.
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  /** Omit to accept the DB default (CUSTOMER). */
  role?: Role;
}

export interface UserRepositoryPort {
  /** One user by (unique) email; null if none. */
  findByEmail(email: string): Promise<User | null>;

  /** One user by id; null if none. */
  findById(id: string): Promise<User | null>;

  /** Insert a new user and return the persisted entity (id/timestamps filled). */
  create(input: CreateUserInput): Promise<User>;
}
