/** Which bound stopped the spin: real time ran out (`deadline`), or nothing observable advanced (`loop_cap`). */
export type ClockStallReason = 'deadline' | 'loop_cap';

/**
 * The clock stopped advancing while the generator waited for the next millisecond, so it refused to
 * mint rather than reuse a `(timestamp, node, sequence)` triple. A transient host fault, hence 503.
 * Dependency-free, so the global exception filter can map it without pulling the generator — and its
 * clock state — into the filter's import graph.
 */
export class ClockStalledError extends Error {
  constructor(readonly reason: ClockStallReason) {
    super(`Identity clock stalled while waiting for the next millisecond (${reason})`);
    this.name = 'ClockStalledError';
  }
}

/** The process holds no node id it may mint under right now. Another replica can, hence 503. */
export class LeaseNotHeldError extends Error {
  constructor(readonly state: string) {
    super(`No node lease to mint under (${state})`);
    this.name = 'LeaseNotHeldError';
  }
}
