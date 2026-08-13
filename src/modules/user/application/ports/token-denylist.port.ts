/**
 * Denylists an access-token `jti` until its `exp` — lets logout revoke an otherwise-stateless token.
 * See docs/engineering-notes.md (Auth — Token model).
 */
export const TOKEN_DENYLIST = Symbol('TOKEN_DENYLIST');

export interface TokenDenylistPort {
  /** Deny `jti` until `expiresAt` (its own `exp`); storage must auto-expire the entry. No-op if already past. */
  denylist(jti: string, expiresAt: Date): Promise<void>;

  /** True while the `jti` is denylisted (i.e. present and not yet expired). */
  isDenylisted(jti: string): Promise<boolean>;
}
