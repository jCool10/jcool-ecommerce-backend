import type { Role } from '../../../shared/rbac/role.enum';

/**
 * Custom access-token claims — the single contract shared by the sign side
 * (AuthTokensService) and the verify side (JwtStrategy), so a rename is a compile
 * error on both ends. Registered claims (iat/exp) are added by the JWT library.
 */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  /** Authorization role, mirrored from the user at issue time. */
  role: Role;
  /** Unique token id (uuid v7) — the handle a logout denylists to revoke this token. */
  jti: string;
}
