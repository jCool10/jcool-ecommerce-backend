export const USER_CONTACT = Symbol('USER_CONTACT');

export interface UserContact {
  email: string;
}

/** Order's view of the user directory: only what a confirmation needs, from wherever users live. */
export interface UserContactPort {
  /**
   * null when the user does not exist. `asOf` is when the caller needed them to: a directory still
   * filling in after a cutover answers "not yet" by throwing instead.
   */
  find(userId: string, asOf: Date): Promise<UserContact | null>;
}
