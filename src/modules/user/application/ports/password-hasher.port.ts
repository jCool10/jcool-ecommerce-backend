// Port for password hashing/verification; the argon2id adapter implements it.
// Isolating the algorithm here keeps a param change or swap out of the use cases.
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasherPort {
  /** Hash a plaintext password into a self-describing digest (salt+params embedded). */
  hash(plain: string): Promise<string>;

  /** True iff `plain` matches `hash`. Never throws on a malformed hash — returns false. */
  verify(hash: string, plain: string): Promise<boolean>;
}
