import type { Role } from '../../../../shared/rbac/role.enum';

/**
 * User's published language — the ONLY surface other bounded contexts may import
 * (enforced by `.dependency-cruiser.cjs`). Returns a safe DTO summary, never the
 * `User` entity (which carries `passwordHash`) or a row.
 *
 * Contract only. Implementation + `UserModule` provider/export land with the
 * first real consumer (e.g. Order attaching the customer identity) — YAGNI until
 * then. Auth itself stays a global concern (guards), not a data facade.
 */
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
