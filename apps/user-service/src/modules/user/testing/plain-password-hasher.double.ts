import type { PasswordHasherPort } from '../application/ports';

/** Stores `hashed:<plain>`, so verify is an equality check. Counts calls for the timing-parity specs. */
export class PlainPasswordHasher implements PasswordHasherPort {
  hashCalls = 0;
  verifyCalls = 0;

  hash(plain: string): Promise<string> {
    this.hashCalls++;
    return Promise.resolve(`hashed:${plain}`);
  }

  verify(digest: string, plain: string): Promise<boolean> {
    this.verifyCalls++;
    return Promise.resolve(digest === `hashed:${plain}`);
  }
}
