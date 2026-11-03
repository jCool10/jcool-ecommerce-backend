import { createLocalJWKSet, jwtVerify } from 'jose';
import type { AccessTokenReaderPort, LiveAccessToken } from '../application/ports';
import type { Es256SigningKeys } from './es256-signing-keys';

export interface Es256ReaderOptions {
  issuer: string;
  audience: string;
}

/** Checks signature, issuer, audience and expiry only: it names a token to revoke, not a caller to admit. */
export class Es256AccessTokenReader implements AccessTokenReaderPort {
  private readonly keys: ReturnType<typeof createLocalJWKSet>;

  constructor(
    signingKeys: Es256SigningKeys,
    private readonly options: Es256ReaderOptions,
  ) {
    this.keys = createLocalJWKSet(signingKeys.jwks);
  }

  async readLive(token: string): Promise<LiveAccessToken | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ['ES256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      const { jti, exp } = payload;
      return typeof jti === 'string' && typeof exp === 'number' ? { jti, exp } : null;
    } catch {
      // Expired, forged or malformed: nothing of ours is live behind it.
      return null;
    }
  }
}
