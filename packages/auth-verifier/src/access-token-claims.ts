import type { Role } from '@jcool/platform/rbac';

/** What an access token asserts, whichever key signed it. */
export interface AccessTokenClaims {
  sub: string;
  /** Mirrored from the user at issue time, so it goes stale until the next refresh. */
  role: Role;
  /** The handle a logout denylists. */
  jti: string;
  /** Rejected once the user's stored epoch moves past it. */
  epoch: number;
}
