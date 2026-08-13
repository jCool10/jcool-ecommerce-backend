/** A business-rule violation raised from inside the domain, distinct from infrastructure failures so the interface layer can map it deterministically (the exception filter turns `DomainError` into 422 and lets unexpected errors surface as 500). */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
