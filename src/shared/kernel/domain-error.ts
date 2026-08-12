/**
 * A business-rule violation raised from inside the domain (invalid VO, broken
 * aggregate invariant, illegal state transition). Distinct from infrastructure
 * failures (DB/network) so the interface layer can map it deterministically —
 * an HTTP exception filter turns `DomainError` into 422 while letting
 * unexpected errors surface as 500.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
