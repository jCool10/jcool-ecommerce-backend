export const SESSION_EPOCH = Symbol('SESSION_EPOCH');

/** What the verifier needs; a service that only verifies binds nothing more. */
export interface SessionEpochReader {
  /** null when the user does not exist. */
  current(userId: string): Promise<number | null>;
}

/** Global access-token revocation primitive: a bump invalidates every outstanding token. */
export interface SessionEpochPort extends SessionEpochReader {
  /** Atomic increment; returns the new value. */
  bump(userId: string): Promise<number>;
}
