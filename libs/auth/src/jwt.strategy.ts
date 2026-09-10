import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type SecretOrKeyProvider } from 'passport-jwt';
import type { AuthenticatedUser } from '@shared/rbac';
import type { AccessTokenClaims } from './access-token-claims';
import { SESSION_EPOCH_READER, type SessionEpochReaderPort } from './session-epoch-reader.port';
import { TOKEN_DENYLIST, type TokenDenylistPort } from './token-denylist.port';

interface AccessTokenPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
}

/** Reads `kid` off the JOSE header without verifying anything — key selection only. */
function readKeyId(rawJwt: string): string | undefined {
  const [header] = rawJwt.split('.');
  if (!header) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const kid = (decoded as { kid?: unknown }).kid;
    return typeof kid === 'string' ? kid : undefined;
  } catch {
    return undefined;
  }
}

/** Exported for the unit test: passport keeps its provider private once the strategy is built. */
export function createSecretOrKeyProvider(keys: ReadonlyMap<string, string>): SecretOrKeyProvider {
  return (_request, rawJwt, done) => {
    const key = typeof rawJwt === 'string' ? keys.get(readKeyId(rawJwt) ?? '') : undefined;
    if (!key) {
      done(new UnauthorizedException('Unknown token key'), undefined);
      return;
    }
    done(null, key);
  };
}

/**
 * Verify-only: a public key and Redis, no private key and no database. `algorithms: ['ES256']` is
 * pinned to block algorithm confusion. Two stateful checks make revocation immediate — the jti
 * denylist (one logged-out token) and the projected session epoch (every token minted before a
 * logout-all or change-password).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylistPort,
    @Inject(SESSION_EPOCH_READER) private readonly sessionEpoch: SessionEpochReaderPort,
  ) {
    // One entry today. Rotation is additive: publish the next key here, sign with it once every
    // verifier has it, and retire the old kid a token TTL later.
    const keys = new Map<string, string>([
      [config.getOrThrow<string>('auth.jwtKeyId'), config.getOrThrow<string>('auth.jwtPublicKey')],
    ]);

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: createSecretOrKeyProvider(keys),
      algorithms: ['ES256'],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // A logged-out token stays cryptographically valid until exp — the denylist makes logout immediate.
    if (await this.denylist.isDenylisted(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    // Fail closed on a missing projection: it means the user is gone or Redis lost the key, and a
    // rejection sends the client through refresh, which rewrites it.
    const currentEpoch = await this.sessionEpoch.current(payload.sub);
    if (currentEpoch === null || (payload.epoch ?? 0) < currentEpoch) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return { userId: payload.sub, role: payload.role, email: payload.email, jti: payload.jti, exp: payload.exp };
  }
}
