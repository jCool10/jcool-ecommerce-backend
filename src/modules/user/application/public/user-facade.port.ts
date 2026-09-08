import type { Role } from '@shared/rbac';

/**
 * The only surface other bounded contexts may import (enforced by `.dependency-cruiser.cjs`).
 * It returns a summary, never the `User` entity (which carries `passwordHash`) or a row.
 */
export const USER_FACADE = Symbol('USER_FACADE');

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
}

export interface UserFacade {
  getUserSummary(id: string): Promise<UserSummary | null>;
}
