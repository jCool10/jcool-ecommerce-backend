import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '..';
import {
  REFRESH_TOKEN_REPOSITORY,
  type ActiveSession,
  type PasswordReplacement,
  publishEpochOrRaise,
  type RefreshTokenRepositoryPort,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochPublisherPort,
} from '../ports';

@Injectable()
export class SessionService {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepo: RefreshTokenRepositoryPort,
    @Inject(SESSION_EPOCH_PUBLISHER) private readonly sessionEpochPublisher: SessionEpochPublisherPort,
  ) {}

  listActiveSessions(userId: string, currentRawToken: string | null): Promise<ActiveSession[]> {
    const currentHash = currentRawToken ? hashRefreshToken(currentRawToken) : null;
    return this.refreshTokenRepo.listActiveSessions(userId, currentHash);
  }

  /** False if the session isn't theirs. */
  revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.refreshTokenRepo.revokeFamily(userId, sessionId);
  }

  // The epoch bump is what rejects already-issued access tokens; revoking the refresh rows alone
  // would only stop the next refresh.
  async revokeAll(userId: string): Promise<void> {
    const epoch = await this.refreshTokenRepo.revokeAllForUser(userId);
    await this.publish(userId, epoch);
  }

  /**
   * The new hash, the epoch bump and the revoke commit together, so no session outlives the old
   * password. False when nothing was written (see {@link RefreshTokenRepositoryPort.revokeAllForUser}).
   */
  async replacePassword(userId: string, replacement: PasswordReplacement): Promise<boolean> {
    const epoch = await this.refreshTokenRepo.revokeAllForUser(userId, replacement);
    await this.publish(userId, epoch);
    return epoch !== null;
  }

  private async publish(userId: string, epoch: number | null): Promise<void> {
    if (epoch !== null) await publishEpochOrRaise(this.sessionEpochPublisher, userId, epoch);
  }
}
