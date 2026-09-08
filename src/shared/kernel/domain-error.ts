/** The exception filter maps this to 422; anything else surfaces as a 500, so infrastructure
 * failures must not be reported as a `DomainError`. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
