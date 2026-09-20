import type { JWTVerifyGetKey } from 'jose';

export const AUTH_VERIFIER_OPTIONS = Symbol('AUTH_VERIFIER_OPTIONS');

export interface AuthVerifierOptions {
  /** The legacy path. Off refuses every HS256 token before its signature is looked at. */
  hs256: { enabled: boolean; secret?: string };
  /**
   * `keys` is a local JWK set where the keys live, a remote one everywhere else. Absent refuses every
   * ES256 token, which is how a service runs before it trusts an issuer.
   */
  es256?: { keys: JWTVerifyGetKey; issuer: string; audience: string };
}
