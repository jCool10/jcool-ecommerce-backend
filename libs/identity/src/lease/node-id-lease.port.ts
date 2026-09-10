/** A held lease. `leaseId` is the fencing token and the only value renew/release match on. */
export interface NodeLease {
  service: string;
  node: number;
  leaseId: string;
}

export interface NodeIdLeasePort {
  /** Seeds the service's pool on first contact, then takes the lowest reclaimable node. */
  acquire(service: string, holder: string): Promise<NodeLease | null>;

  /** `false` means the row no longer carries this `leaseId` — the lease was stolen. */
  renew(lease: NodeLease, lastMs: number): Promise<boolean>;

  /**
   * `lastMs` travels with the release for the same reason it travels with a renewal: without it the
   * reclaimer would compare against a value up to one renewal interval old, and "released nodes are
   * immediately re-acquirable" would contradict "a triple is never replayed".
   */
  release(lease: NodeLease, lastMs: number): Promise<void>;
}

export const NODE_ID_LEASE = Symbol('NODE_ID_LEASE');
