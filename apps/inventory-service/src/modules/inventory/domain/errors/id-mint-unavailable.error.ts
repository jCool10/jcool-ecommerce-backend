/**
 * The id-service could not mint the ids a Try needs. Only the Try mints, so the caller must not read
 * it as a fault of the commands that share its breaker.
 */
export class IdMintUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Reservation ids could not be minted', options);
    this.name = 'IdMintUnavailableError';
  }
}
