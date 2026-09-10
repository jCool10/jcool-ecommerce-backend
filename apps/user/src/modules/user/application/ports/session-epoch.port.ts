export const SESSION_EPOCH = Symbol('SESSION_EPOCH');

/** Global access-token revocation primitive: a bump invalidates every outstanding token. */
export interface SessionEpochPort {
  /** null when the user does not exist. */
  current(userId: string): Promise<number | null>;

  /** Atomic increment; returns the new value. */
  bump(userId: string): Promise<number>;
}
