/**
 * Port for the access-token denylist. Access tokens are stateless (verified by
 * signature + `exp` only), so a logout cannot invalidate them on its own. Logout
 * records the token's `jti` here until its natural expiry; JwtStrategy consults
 * it on every request — giving immediate revocation while the happy path stays
 * stateless (a single, auto-expiring lookup).
 */
export const TOKEN_DENYLIST = Symbol('TOKEN_DENYLIST');

export interface TokenDenylistPort {
  /**
   * Deny a token's `jti` until `expiresAt` (the token's own `exp`). Storage must
   * auto-expire the entry, so the denylist never outgrows the set of live access
   * tokens. A no-op when `expiresAt` is already in the past.
   */
  denylist(jti: string, expiresAt: Date): Promise<void>;

  /** True while the `jti` is denylisted (i.e. present and not yet expired). */
  isDenylisted(jti: string): Promise<boolean>;
}
