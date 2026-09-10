import type { Role } from '@shared/rbac';

/** Shared contract between signing (the issuer app) and verifying (JwtStrategy here). */
export interface AccessTokenClaims {
  sub: string;
  /** Mirrored from the user at issue time, so it goes stale until the next refresh. */
  role: Role;
  /** Same staleness contract as `role`. Checkout snapshots it onto the order. */
  email: string;
  /** uuid v7 — the handle a logout denylists. */
  jti: string;
  /** JwtStrategy rejects the token once the projected epoch moves past this. */
  epoch: number;
}
