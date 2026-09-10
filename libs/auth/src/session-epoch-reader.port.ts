export const SESSION_EPOCH_READER = Symbol('SESSION_EPOCH_READER');

/** The verifier's half of the epoch projection: read-only, no database. */
export interface SessionEpochReaderPort {
  /** null when the projection holds nothing for this user — the verifier fails closed on it. */
  current(userId: string): Promise<number | null>;
}
