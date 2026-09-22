import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '..';
import {
  REFRESH_TOKEN_REPOSITORY,
  type ActiveSession,
  type RefreshTokenRepositoryPort,
  SESSION_EPOCH,
  SessionEpochNotPublishedError,
  type SessionEpochPort,
} from '../ports';

@Injectable()
export class SessionService {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
  ) {}

  listActiveSessions(userId: string, currentRawToken: string | null): Promise<ActiveSession[]> {
    const currentHash = currentRawToken ? hashRefreshToken(currentRawToken) : null;
    return this.refreshTokens.listActiveSessions(userId, currentHash);
  }

  /** False if the session isn't theirs. */
  revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.refreshTokens.revokeFamily(userId, sessionId);
  }

  // The epoch bump is what rejects already-issued access tokens; revoking the refresh rows alone
  // would only stop the next refresh.
  async revokeAll(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
    await this.sessionEpoch.bump(userId);
  }

  /** `revokeAll`, then `write`. A failed publish is surfaced only after the write, which it must not skip. */
  async revokeAllThen(userId: string, write: () => Promise<void>): Promise<void> {
    let unpublished: SessionEpochNotPublishedError | undefined;
    try {
      await this.revokeAll(userId);
    } catch (error) {
      if (!(error instanceof SessionEpochNotPublishedError)) throw error;
      unpublished = error;
    }
    await write();
    if (unpublished) throw unpublished;
  }
}
