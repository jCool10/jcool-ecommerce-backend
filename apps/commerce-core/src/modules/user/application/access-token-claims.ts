import type { Role } from '@shared/rbac';

/** Shared contract between signing (AuthTokensService) and verifying (JwtStrategy). */
export interface AccessTokenClaims {
  sub: string;
  /** Mirrored from the user at issue time, so it goes stale until the next refresh. */
  role: Role;
  /** uuid v7 — the handle a logout denylists. */
  jti: string;
  /** JwtStrategy rejects the token once the user's stored epoch moves past this. */
  epoch: number;
}
