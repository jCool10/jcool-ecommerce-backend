import type { Role } from '@shared/rbac';

/** User's published language — the only surface other bounded contexts may import (enforced by `.dependency-cruiser.cjs`); returns a safe DTO summary, never the `User` entity (which carries `passwordHash`) or a row. */
export const USER_FACADE = Symbol('USER_FACADE');

/** Safe cross-context view of a user (no credentials). */
export interface UserSummary {
  id: string;
  email: string;
  role: Role;
}

export interface UserFacade {
  /** One user by id; null if none. */
  getUserSummary(id: string): Promise<UserSummary | null>;
}
