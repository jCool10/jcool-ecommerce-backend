import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenClaims } from '../../application';
import { SESSION_EPOCH, type SessionEpochPort, TOKEN_DENYLIST, type TokenDenylistPort } from '../../application/ports';
import type { AuthenticatedUser } from '@shared/rbac';

interface AccessTokenPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
}

/**
 * `algorithms: ['HS256']` is pinned to block algorithm-confusion attacks. Two stateful checks make
 * revocation immediate: the jti denylist (one logged-out token) and the session epoch (every token
 * minted before a logout-all or change-password).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylistPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // A logged-out token stays cryptographically valid until exp — the denylist makes logout immediate.
    if (await this.denylist.isDenylisted(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    // Reject a token whose epoch predates the user's current one; null = user gone (reject),
    // missing claim = treated as epoch 0.
    const currentEpoch = await this.sessionEpoch.current(payload.sub);
    if (currentEpoch === null || (payload.epoch ?? 0) < currentEpoch) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return { userId: payload.sub, role: payload.role, jti: payload.jti, exp: payload.exp };
  }
}
