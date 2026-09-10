// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
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
  /**
   * Pass `tx` when calling from inside a unit of work — a consumer transaction holds a pool
   * connection for its whole life, so a second one taken here competes with it for the pool.
   */
  getUserSummary(id: string, tx?: DrizzleTx): Promise<UserSummary | null>;
}
