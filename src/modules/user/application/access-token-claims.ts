import type { Role } from '../../../shared/rbac';

/** Custom access-token claims — the shared contract for signing (AuthTokensService) and verifying (JwtStrategy). */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  /** Authorization role, mirrored from the user at issue time. */
  role: Role;
  /** Unique token id (uuid v7) — the handle a logout denylists. */
  jti: string;
  /** Session epoch at issue time; JwtStrategy rejects the token once the user's stored epoch moves past it. */
  epoch: number;
}
