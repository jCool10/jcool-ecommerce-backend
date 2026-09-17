/** Denylists an access-token `jti` until its `exp` — lets logout revoke an otherwise-stateless token. */
export const TOKEN_DENYLIST = Symbol('TOKEN_DENYLIST');

export interface TokenDenylistPort {
  /** `expiresAt` is the token's own `exp`; storage must auto-expire the entry. No-op if already past. */
  denylist(jti: string, expiresAt: Date): Promise<void>;

  isDenylisted(jti: string): Promise<boolean>;
}
