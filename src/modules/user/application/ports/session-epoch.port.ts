export const SESSION_EPOCH = Symbol('SESSION_EPOCH');

/** Per-user monotonic session epoch — the global access-token revocation primitive (a bump invalidates every outstanding token). */
export interface SessionEpochPort {
  /** The user's current epoch; null when the user does not exist. */
  current(userId: string): Promise<number | null>;

  /** Atomically increment the user's epoch and return the new value. */
  bump(userId: string): Promise<number>;
}
