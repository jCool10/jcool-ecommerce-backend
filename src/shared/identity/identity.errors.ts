/** Which bound stopped the spin: real time ran out (`deadline`), or nothing observable advanced at all (`loop_cap`). */
export type ClockStallReason = 'deadline' | 'loop_cap';

/**
 * The clock stopped advancing while the generator waited for the next millisecond, so it refused to
 * mint rather than reuse a `(timestamp, node, sequence)` triple. The fault is the host's and it is
 * transient, which is why the interface layer answers 503 rather than 500.
 *
 * Deliberately dependency-free so the global exception filter can map it to a status without
 * pulling the generator — and its clock state — into the filter's import graph.
 */
export class ClockStalledError extends Error {
  constructor(readonly reason: ClockStallReason) {
    super(`Identity clock stalled while waiting for the next millisecond (${reason})`);
    this.name = 'ClockStalledError';
  }
}
