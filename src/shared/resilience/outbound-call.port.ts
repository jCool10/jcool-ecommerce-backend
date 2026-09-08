export interface OutboundCall {
  /**
   * The task's own rejection passes through untouched; only the breaker's verdict becomes a
   * `DownstreamUnavailableError`. There is deliberately no degraded stand-in value: for the calls
   * worth guarding — the ones that move money or release stock — a made-up answer is worse than none.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * `open`: never called — the circuit is open, or the breaker went down with the process.
 * `timeout`: it was called, and we stopped waiting for its answer.
 */
export type UnavailableReason = 'open' | 'timeout';

/** Raised by the breaker, never by the guarded task — so a caller can tell "we didn't ask" from "they said no". */
export class DownstreamUnavailableError extends Error {
  constructor(
    readonly breaker: string,
    readonly reason: UnavailableReason,
    readonly cause?: unknown,
  ) {
    super(
      reason === 'open'
        ? `${breaker} is unavailable — the call was refused without being attempted`
        : `${breaker} did not answer in time`,
    );
    this.name = 'DownstreamUnavailableError';
  }
}
