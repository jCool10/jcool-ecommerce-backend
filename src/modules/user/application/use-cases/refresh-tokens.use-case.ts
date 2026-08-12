import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from '../ports/refresh-token-repository.port';
import { AuthTokensService, type AuthTokens } from '../services/auth-tokens.service';

// One generic message for every failure branch so a caller can't probe validity.
const INVALID_REFRESH_TOKEN = 'Invalid refresh token';

/**
 * Rotate a refresh token with automatic reuse detection. The atomic decision
 * lives in the repository's `rotate`; this maps its outcome to HTTP:
 * `invalid`/`reuse` → 401 (reuse warns server-side), `rotated` → new token pair.
 * The successor is generated up front and only persisted on success.
 */
@Injectable()
export class RefreshTokensUseCase {
  private readonly logger = new Logger(RefreshTokensUseCase.name);

  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    private readonly authTokens: AuthTokensService,
  ) {}

  async execute(rawRefreshToken: string): Promise<AuthTokens> {
    const successor = this.authTokens.newRefreshToken();
    const outcome = await this.refreshTokens.rotate({
      presentedTokenHash: hashRefreshToken(rawRefreshToken),
      newTokenHash: successor.hash,
      newExpiresAt: successor.expiresAt,
    });

    if (outcome.status === 'reuse') {
      // Family already revoked in the transaction. A superseded token being
      // replayed is the classic stolen-token signature (warn); a merely-revoked
      // one is benign (debug). Either way the client gets the same generic 401.
      const context = `userId=${outcome.userId}, familyId=${outcome.familyId}`;
      if (outcome.replaced) {
        this.logger.warn(`Refresh token reuse detected — session revoked (${context})`);
      } else {
        this.logger.debug(`Revoked refresh token replayed — session already ended (${context})`);
      }
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    if (outcome.status === 'invalid') {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    const accessToken = await this.authTokens.signAccess(outcome.userId, outcome.role);
    return {
      accessToken,
      refreshToken: successor.raw,
      expiresIn: this.authTokens.accessExpiresIn,
    };
  }
}
