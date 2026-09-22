import { SignJWT } from 'jose';
import type { AccessTokenClaims } from '@jcool/auth-verifier';
import type { AccessTokenSignerPort } from '../application/ports';
import type { Es256SigningKeys } from './es256-signing-keys';

export interface Es256SignerOptions {
  issuer: string;
  audience: string;
  /** Seconds. */
  expiresIn: number;
}

export class Es256AccessTokenSigner implements AccessTokenSignerPort {
  readonly expiresIn: number;

  constructor(
    private readonly keys: Es256SigningKeys,
    private readonly options: Es256SignerOptions,
  ) {
    this.expiresIn = options.expiresIn;
  }

  sign({ sub, role, jti, epoch }: AccessTokenClaims): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({ role, epoch })
      .setProtectedHeader({ alg: 'ES256', kid: this.keys.activeKid, typ: 'JWT' })
      .setSubject(sub)
      .setJti(jti)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.expiresIn)
      .sign(this.keys.activeKey);
  }
}
