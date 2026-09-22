export interface LeaseGrant {
  nodeId: number;
  /** Bumped by every acquire, so a renew or release from an earlier holder of the node matches nothing. */
  generation: number;
  /** Highest timestamp any earlier holder reported minting at; null for a node never minted on. */
  floorMs: number | null;
  /** Where the previous holder's lease ended (0 for a node never leased). It never minted past this. */
  prevUntilMs: number;
  /** Where this lease ends. */
  leaseUntilMs: number;
  /** The store's clock when it wrote the grant, the reference `floorMs` is judged against. */
  dbNowMs: number;
}

/**
 * Every time comparison belongs to the store's clock, never a replica's: the replicas disagree
 * about the time, which is the whole reason a lease exists.
 */
export interface LeaseStore {
  /** Claims the node whose lease ran out longest ago, once past quarantine. Null when none is free. */
  acquire(request: { holder: string; ttlMs: number; quarantineMs: number }): Promise<LeaseGrant | null>;

  /**
   * The new lease end, or null once the lease has expired or passed to another generation.
   * `lastMs` is recorded either way.
   */
  renew(request: {
    nodeId: number;
    holder: string;
    generation: number;
    ttlMs: number;
    lastMs: number;
  }): Promise<number | null>;

  /** `lastMs` null when nothing was minted, which leaves the recorded floor untouched. */
  release(request: { nodeId: number; holder: string; generation: number; lastMs: number | null }): Promise<void>;
}
