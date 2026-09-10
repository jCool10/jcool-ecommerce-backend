import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '..';
import {
  REFRESH_TOKEN_REPOSITORY,
  type ActiveSession,
  type RefreshTokenRepositoryPort,
  SESSION_EPOCH,
  type SessionEpochPort,
  SESSION_EPOCH_PROJECTION,
  type SessionEpochProjectionPort,
} from '../ports';

@Injectable()
export class SessionService {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(SESSION_EPOCH) private readonly sessionEpoch: SessionEpochPort,
    @Inject(SESSION_EPOCH_PROJECTION) private readonly epochProjection: SessionEpochProjectionPort,
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
    await this.revokeAccessTokens(userId);
  }

  /**
   * Bump plus its Redis mirror — the only place either happens, so the two can never disagree.
   * `bump()` returns 0 only when it updated no row, i.e. the user is gone: publishing that would
   * hand their outstanding tokens a valid epoch, so the projection is dropped instead and the
   * verifier fails closed.
   */
  async revokeAccessTokens(userId: string): Promise<void> {
    const epoch = await this.sessionEpoch.bump(userId);
    if (epoch === 0) {
      await this.epochProjection.revoke(userId);
    } else {
      await this.epochProjection.publish(userId, epoch);
    }
  }
}
