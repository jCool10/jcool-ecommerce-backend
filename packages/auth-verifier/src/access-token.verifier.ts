import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type JWTPayload, type JWTVerifyResult, decodeProtectedHeader, jwtVerify } from 'jose';
import { type AuthenticatedUser, ROLES, type Role } from '@jcool/platform/rbac';
import type { AccessTokenClaims } from './access-token-claims';
import { AUTH_VERIFIER_OPTIONS, type AuthVerifierOptions } from './auth-verifier.options';
import { SESSION_EPOCH, type SessionEpochReader } from './session-epoch.port';
import { TOKEN_DENYLIST, type TokenDenylistReader } from './token-denylist.port';

type VerifiedClaims = AccessTokenClaims & { exp: number };

/**
 * ES256 is the only path, so the algorithm in the header can never pick the kind of key a token is
 * checked against — anything else is refused before its signature is looked at.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(
    @Inject(AUTH_VERIFIER_OPTIONS) private readonly options: AuthVerifierOptions,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochReader,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylistReader,
  ) {}

  async verify(token: string | undefined): Promise<AuthenticatedUser> {
    const claims = token ? await this.verifiedClaims(token) : null;
    if (!claims) {
      throw new UnauthorizedException();
    }

    if (await this.denylist.isDenylisted(claims.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }
    const currentEpoch = await this.sessionEpoch.current(claims.sub);
    if (currentEpoch === null || claims.epoch < currentEpoch) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return { userId: claims.sub, role: claims.role, jti: claims.jti, exp: claims.exp };
  }

  private async verifiedClaims(token: string): Promise<VerifiedClaims | null> {
    try {
      return toClaims((await this.verifySignature(token)).payload);
    } catch {
      return null;
    }
  }

  private verifySignature(token: string): Promise<JWTVerifyResult> {
    const { alg } = decodeProtectedHeader(token);
    if (alg !== 'ES256') {
      return Promise.reject(new Error(`no verification path for alg ${String(alg)}`));
    }
    const { keys, issuer, audience } = this.options.es256;
    return jwtVerify(token, keys, { algorithms: ['ES256'], issuer, audience });
  }
}

function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

// A token minted before epochs existed carries none; it reads as 0.
function toClaims(payload: JWTPayload): VerifiedClaims | null {
  const { sub, jti, exp, role, epoch = 0 } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number') return null;
  if (!isRole(role) || typeof epoch !== 'number') return null;
  return { sub, role, jti, epoch, exp };
}
