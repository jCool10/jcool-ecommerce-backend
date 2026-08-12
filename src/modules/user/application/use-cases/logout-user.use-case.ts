import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from '../ports/refresh-token-repository.port';

/**
 * Log out one session: revoke the presented refresh token (scoped to the user).
 * Idempotent — an unknown/foreign/already-revoked token is a silent no-op, so
 * the controller always returns 204. Scope is this token only, not the family.
 */
@Injectable()
export class LogoutUserUseCase {
  constructor(@Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort) {}

  async execute(userId: string, rawRefreshToken: string): Promise<void> {
    await this.refreshTokens.revoke(userId, hashRefreshToken(rawRefreshToken));
  }
}
