import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import {
  REFRESH_TOKEN_REPOSITORY,
  type ActiveSession,
  type RefreshTokenRepositoryPort,
} from '../ports/refresh-token-repository.port';
import { SESSION_EPOCH, type SessionEpochPort } from '../ports/session-epoch.port';

/** Account-owner session management: list active sessions, revoke one, or sign out everywhere. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
  ) {}

  /** List the user's active sessions; `currentRawToken` flags the caller's own. */
  listActiveSessions(userId: string, currentRawToken: string | null): Promise<ActiveSession[]> {
    const currentHash = currentRawToken ? hashRefreshToken(currentRawToken) : null;
    return this.refreshTokens.listActiveSessions(userId, currentHash);
  }

  /** Revoke one session (token family) owned by the user; false if it isn't theirs. */
  revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.refreshTokens.revokeFamily(userId, sessionId);
  }

  // Sign out everywhere: revoke all refresh tokens (durable) + bump the epoch to reject
  // every outstanding access token at once (revoking one session only stops its refresh).
  async revokeAll(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
    await this.sessionEpoch.bump(userId);
  }
}
