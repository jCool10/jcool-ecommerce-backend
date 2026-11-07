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

/** For an epoch already committed: a failed publish becomes a 5xx the reconciler later repairs. */
export async function publishEpochOrRaise(
  publisher: SessionEpochPublisherPort,
  userId: string,
  epoch: number,
): Promise<void> {
  try {
    await publisher.publish(userId, epoch);
  } catch (error) {
    throw new SessionEpochNotPublishedError(userId, epoch, error);
  }
}
