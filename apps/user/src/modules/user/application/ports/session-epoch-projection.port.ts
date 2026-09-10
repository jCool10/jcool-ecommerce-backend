export const SESSION_EPOCH_PROJECTION = Symbol('SESSION_EPOCH_PROJECTION');

/**
 * Write half of the epoch projection the verifier reads. Postgres stays the source of truth: a
 * failed write here delays a revocation by at most one access-token TTL, it never loses one.
 */
export interface SessionEpochProjectionPort {
  publish(userId: string, epoch: number): Promise<void>;
  /** Drop the key so the verifier fails closed — used when the user no longer exists. */
  revoke(userId: string): Promise<void>;
}
