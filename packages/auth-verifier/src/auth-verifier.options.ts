import type { JWTVerifyGetKey } from 'jose';

export const AUTH_VERIFIER_OPTIONS = Symbol('AUTH_VERIFIER_OPTIONS');

export interface AuthVerifierOptions {
  /** `keys` is a local JWK set where the keys live, a remote one everywhere else. */
  es256: { keys: JWTVerifyGetKey; issuer: string; audience: string };
}
