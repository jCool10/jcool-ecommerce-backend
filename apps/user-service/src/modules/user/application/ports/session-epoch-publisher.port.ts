export const SESSION_EPOCH_PUBLISHER = Symbol('SESSION_EPOCH_PUBLISHER');

/** Where other services read a user's epoch from. This service is its only writer. */
export interface SessionEpochPublisherPort {
  /** Raises the published epoch to at least `epoch`, never lowers it; resolves to what is now published. */
  publish(userId: string, epoch: number): Promise<number>;
}

/** The bump is committed; only its publish failed, and the reconciler carries it on its next pass. */
export class SessionEpochNotPublishedError extends Error {
  constructor(
    readonly userId: string,
    readonly epoch: number,
    cause: unknown,
  ) {
    super(`session epoch ${epoch} not published for user ${userId}`, { cause });
    this.name = 'SessionEpochNotPublishedError';
  }
}
