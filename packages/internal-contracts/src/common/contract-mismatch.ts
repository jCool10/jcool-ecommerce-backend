export class ContractMismatch extends Error {
  constructor(step: number, op: string, expected: unknown, actual: unknown) {
    super(`step ${step} (${op}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    this.name = 'ContractMismatch';
  }
}
