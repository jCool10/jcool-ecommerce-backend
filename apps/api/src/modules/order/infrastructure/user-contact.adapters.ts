import type { UserServiceClient } from '@shared/user-service/user-service.client';
import type { UserContact, UserContactPort } from '../application/ports/user-contact.port';

/** Retryable on purpose: the user may still be on the way to the directory. */
export class UserNotYetInDirectoryError extends Error {
  constructor(userId: string) {
    super(`user ${userId} is not in the user directory yet`);
    this.name = 'UserNotYetInDirectoryError';
  }
}

/**
 * Users live in the user-service. Its database may have been restored from a copy a little older
 * than the cutover, so for a grace window after the event a missing user reads as "not yet".
 */
export class RemoteUserContactAdapter implements UserContactPort {
  constructor(
    private readonly userService: Pick<UserServiceClient, 'userSummary'>,
    private readonly notFoundGraceMs: number,
  ) {}

  async find(userId: string, asOf: Date): Promise<UserContact | null> {
    const summary = await this.userService.userSummary(userId);
    if (summary) return { email: summary.email };
    if (Date.now() - asOf.getTime() < this.notFoundGraceMs) throw new UserNotYetInDirectoryError(userId);
    return null;
  }
}
