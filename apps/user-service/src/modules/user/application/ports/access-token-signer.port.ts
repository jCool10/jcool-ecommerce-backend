import type { AccessTokenClaims } from '@jcool/auth-verifier';

export const ACCESS_TOKEN_SIGNER = Symbol('ACCESS_TOKEN_SIGNER');

export interface AccessTokenSignerPort {
  /** Seconds a signed token lives. */
  readonly expiresIn: number;

  sign(claims: AccessTokenClaims): Promise<string>;
}
