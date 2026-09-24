import type { AccessTokenClaims } from '@jcool/auth-verifier';
import type { AccessTokenSignerPort } from '../application/ports';

/** The token is the JSON of the claims it was asked to sign; real signing is the ES256 signer's spec. */
export class EchoAccessTokenSigner implements AccessTokenSignerPort {
  readonly expiresIn = 900;
  readonly signed: AccessTokenClaims[] = [];

  sign(claims: AccessTokenClaims): Promise<string> {
    this.signed.push(claims);
    return Promise.resolve(JSON.stringify(claims));
  }
}

export const claimsOf = (token: string): AccessTokenClaims => JSON.parse(token) as AccessTokenClaims;
