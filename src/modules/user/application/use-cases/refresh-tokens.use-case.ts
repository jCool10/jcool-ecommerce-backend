import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import { AUTH_AUDIT, type AuthAuditPort } from '../ports/auth-audit.port';
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from '../ports/refresh-token-repository.port';
import { SESSION_EPOCH, type SessionEpochPort } from '../ports/session-epoch.port';
import { AuthTokensService, type AuthTokens } from '../services/auth-tokens.service';

// One generic message for every failure branch so a caller can't probe validity.
const INVALID_REFRESH_TOKEN = 'Invalid refresh token';

/**
 * Rotate a refresh token with reuse detection: the atomic decision is the repository's
 * `rotate`; this maps the outcome to HTTP (invalid/reuse → 401, rotated → new pair).
 */
@Injectable()
export class RefreshTokensUseCase {
  private readonly logger = new Logger(RefreshTokensUseCase.name);

  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    private readonly authTokens: AuthTokensService,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
  ) {}

  async execute(rawRefreshToken: string): Promise<AuthTokens> {
    const successor = this.authTokens.newRefreshToken();
    const outcome = await this.refreshTokens.rotate({
      presentedTokenHash: hashRefreshToken(rawRefreshToken),
      newTokenHash: successor.hash,
      newExpiresAt: successor.expiresAt,
    });

    if (outcome.status === 'reuse') {
      // Family already revoked in the transaction; the client always gets a generic 401.
      const context = `userId=${outcome.userId}, familyId=${outcome.familyId}`;
      if (outcome.replaced) {
        // Superseded token replayed — the classic stolen-token signature; audit it.
        this.audit.record({
          event: 'token.reuse_detected',
          outcome: 'failure',
          userId: outcome.userId,
          reason: 'refresh_token_reuse',
          metadata: { familyId: outcome.familyId },
        });
        this.logger.warn(`Refresh token reuse detected — session revoked (${context})`);
        // Also bump the epoch so the access token the thief already rotated out is
        // rejected now, not left alive until its TTL — rotate only revoked refresh rows.
        await this.sessionEpoch.bump(outcome.userId);
      } else {
        // Merely-revoked token replayed (post-logout) — benign, diagnostic only.
        this.logger.debug(`Revoked refresh token replayed — session already ended (${context})`);
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
