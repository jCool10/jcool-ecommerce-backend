import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type JWTPayload, type JWTVerifyResult, decodeProtectedHeader, jwtVerify } from 'jose';
import { isRoutableId } from '@jcool/id-codec';
import { type AuthenticatedUser, ROLES, type Role } from '@jcool/platform/rbac';
import type { AccessTokenClaims } from './access-token-claims';
import { AUTH_VERIFIER_OPTIONS, type AuthVerifierOptions } from './auth-verifier.options';
import { SESSION_EPOCH, type SessionEpochReader } from './session-epoch.port';
import { TOKEN_DENYLIST, type TokenDenylistReader } from './token-denylist.port';

type VerifiedClaims = AccessTokenClaims & { exp: number };

const SESSION_REVOKED = 'Session has been revoked';

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
    if (!token) {
      throw refused('no bearer token');
    }
    const claims = await this.verifiedClaims(token);

    if (await this.denylist.isDenylisted(claims.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }
    const currentEpoch = await this.sessionEpoch.current(claims.sub);
    if (currentEpoch === null) {
      throw refused('no session epoch for the subject', SESSION_REVOKED);
    }
    if (claims.epoch < currentEpoch) {
      throw refused('token epoch is behind the session epoch', SESSION_REVOKED);
    }

    return { userId: claims.sub, role: claims.role, jti: claims.jti, exp: claims.exp };
  }

  private async verifiedClaims(token: string): Promise<VerifiedClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await this.verifySignature(token));
    } catch (error) {
      throw refused(error);
    }
    const claims = toClaims(payload);
    if (!claims) {
      throw refused('token claims are malformed');
    }
    return claims;
  }

  private verifySignature(token: string): Promise<JWTVerifyResult> {
    const { alg } = decodeProtectedHeader(token);
    if (alg !== 'ES256') {
      // The header is the caller's to fill, and this message reaches the 401 log line.
      return Promise.reject(new Error(`no verification path for alg ${String(alg).slice(0, 32)}`));
    }
    const { keys, issuer, audience } = this.options.es256;
    return jwtVerify(token, keys, { algorithms: ['ES256'], issuer, audience });
  }
}

// `cause` is logged, never sent. Passing options drops Nest's default description, so it is restated.
function refused(reason: unknown, message = 'Unauthorized'): UnauthorizedException {
  const cause = typeof reason === 'string' ? new Error(reason) : reason;
  return new UnauthorizedException(message, { cause, description: 'Unauthorized' });
}

function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

// A token minted before epochs existed carries none; it reads as 0. A subject that is not a routable
// id, such as a pre-snowflake UUID, is refused here: every id column downstream throws on it as a 5xx.
function toClaims(payload: JWTPayload): VerifiedClaims | null {
  const { sub, jti, exp, role, epoch = 0 } = payload;
  if (!isRoutableId(sub) || typeof jti !== 'string' || typeof exp !== 'number') return null;
  if (!isRole(role) || typeof epoch !== 'number') return null;
  return { sub, role, jti, epoch, exp };
}
