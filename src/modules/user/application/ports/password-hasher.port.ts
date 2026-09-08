export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasherPort {
  /** Returns a self-describing digest: salt and params are embedded, nothing else needs storing. */
  hash(plain: string): Promise<string>;

  /** Never throws on a malformed hash — returns false. */
  verify(hash: string, plain: string): Promise<boolean>;
}
