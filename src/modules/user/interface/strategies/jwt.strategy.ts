import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenClaims } from '../../application/access-token-claims';
import { TOKEN_DENYLIST, type TokenDenylistPort } from '../../application/ports/token-denylist.port';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

// Verified payload: our custom claims plus the registered iat/exp.
interface AccessTokenPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
}

/**
 * Passport strategy for Bearer access tokens. `algorithms: ['HS256']` is pinned
 * to block algorithm-confusion attacks. Signature + expiry are stateless; the
 * one stateful check is the `jti` denylist, so a logged-out token is rejected
 * immediately instead of surviving until its `exp`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylistPort,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // A revoked (logged-out) access token stays cryptographically valid until
    // exp — the denylist is what makes logout take effect right away.
    if (await this.denylist.isDenylisted(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return { userId: payload.sub, role: payload.role, jti: payload.jti, exp: payload.exp };
  }
}
