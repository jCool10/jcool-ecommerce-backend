import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenClaims } from '../../application/access-token-claims';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

// Verified payload: our custom claims plus the registered iat/exp.
interface AccessTokenPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
}

/**
 * Passport strategy for Bearer access tokens. `algorithms: ['HS256']` is pinned
 * to block algorithm-confusion attacks. `validate` is stateless (trusts the
 * signed claims, no DB hit).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
      algorithms: ['HS256'],
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    return { userId: payload.sub, role: payload.role };
  }
}
