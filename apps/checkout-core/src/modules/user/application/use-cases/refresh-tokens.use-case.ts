import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { hashRefreshToken } from '..';
import {
  AUTH_AUDIT,
  type AuthAuditPort,
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
  SESSION_EPOCH,
  type SessionEpochPort,
} from '../ports';
import { type AuthTokens, AuthTokensService } from '../services';

// One generic message for every failure branch so a caller can't probe validity.
const INVALID_REFRESH_TOKEN = 'Invalid refresh token';

const LOG_CONTEXT = 'RefreshTokens';

@Injectable()
export class RefreshTokensUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    private readonly authTokens: AuthTokensService,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(rawRefreshToken: string): Promise<AuthTokens> {
    const successor = this.authTokens.newRefreshToken();
    const outcome = await this.refreshTokens.rotate({
      presentedTokenHash: hashRefreshToken(rawRefreshToken),
      newTokenHash: successor.hash,
      newExpiresAt: successor.expiresAt,
    });

    if (outcome.status === 'reuse') {
      // Family already revoked in the transaction; the client always gets a generic 401.
      const session = { userId: outcome.userId, familyId: outcome.familyId };
      if (outcome.replaced) {
        // A superseded token replayed is the classic stolen-token signature.
        this.audit.record({
          event: 'token.reuse_detected',
          outcome: 'failure',
          userId: outcome.userId,
          reason: 'refresh_token_reuse',
          metadata: { familyId: outcome.familyId },
        });
        this.logger.warn(session, 'refresh token reuse detected — session revoked');
        // `rotate` only revoked refresh rows, so bump the epoch too: otherwise the access token the
        // thief already rotated out stays alive until its TTL.
        await this.sessionEpoch.bump(outcome.userId);
      } else {
        // A merely-revoked token replayed (post-logout) is benign — diagnostic only.
        this.logger.debug(session, 'revoked refresh token replayed — session already ended');
      }
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    if (outcome.status === 'invalid') {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    const accessToken = await this.authTokens.signAccess(outcome.userId, outcome.role, outcome.tokenEpoch);
    return {
      accessToken,
      refreshToken: successor.raw,
      expiresIn: this.authTokens.accessExpiresIn,
    };
  }
}
