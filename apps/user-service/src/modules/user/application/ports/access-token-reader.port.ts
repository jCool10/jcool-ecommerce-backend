export const ACCESS_TOKEN_READER = Symbol('ACCESS_TOKEN_READER');

export interface LiveAccessToken {
  jti: string;
  /** Epoch seconds. */
  exp: number;
}

export interface AccessTokenReaderPort {
  /**
   * The identity of a token this service signed and that has not yet expired, or null for anything
   * else. Logout uses it to denylist the presented token without making a live one a precondition.
   */
  readLive(token: string): Promise<LiveAccessToken | null>;
}
