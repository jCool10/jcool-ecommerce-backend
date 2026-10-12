export interface LeaseGrant {
  nodeId: number;
  /** Bumped by every acquire, so a renew or release from an earlier holder of the node matches nothing. */
  generation: number;
  /** No earlier holder of the node stamped an id above this; null for a node never leased. */
  floorMs: number | null;
  /** The ceiling this holder reserved: it must not stamp an id above it until a renew raises it. */
  leaseUntilMs: number;
  /** The clock `floorMs` is judged against when deciding whether it sits too far ahead. */
  nowMs: number;
}

/**
 * The store records, per node, a ceiling in the id timestamp domain: a holder never stamps past the
 * ceiling it last reserved, and the next holder starts above it. Uniqueness then needs no clock to
 * agree with any other.
 */
export interface LeaseStore {
  /** Claims a free node, preferring the one idle longest. Null when none is free. */
  acquire(request: { holder: string; ttlMs: number }): Promise<LeaseGrant | null>;

  /** The new ceiling, or null once the lease has expired or passed to another generation. */
  renew(request: {
    nodeId: number;
    holder: string;
    generation: number;
    ttlMs: number;
    lastMs: number;
  }): Promise<number | null>;

  /** `lastMs` null when nothing was minted. Minting must have stopped for good before this is called. */
  release(request: { nodeId: number; holder: string; generation: number; lastMs: number | null }): Promise<void>;
}
