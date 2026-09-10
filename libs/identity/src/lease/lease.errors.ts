/**
 * The node-id lease this process held was taken by another holder, so the generator refuses to mint
 * rather than emit under an id someone else now owns. Dependency-free for the same reason
 * `ClockStalledError` is: the generator and the global exception filter both reach it without
 * pulling the lease's Postgres client into their import graphs.
 */
export class LeaseLostError extends Error {
  constructor() {
    super('Node-id lease lost; this process may no longer mint ids');
    this.name = 'LeaseLostError';
  }
}

/** Every node in the service's pool is held or still inside its clock-skew guard. */
export class NoNodeAvailableError extends Error {
  constructor(readonly service: string) {
    super(`No node id available in the "${service}" pool`);
    this.name = 'NoNodeAvailableError';
  }
}

/** A service name outside `ID_SERVICE_POOLS`. Caught here, a typo would have minted its own pool. */
export class UnknownServicePoolError extends Error {
  constructor(service: string, known: readonly string[]) {
    super(`Unknown id-service pool "${service}"; ID_SERVICE_POOLS declares ${known.join(', ')}`);
    this.name = 'UnknownServicePoolError';
  }
}
