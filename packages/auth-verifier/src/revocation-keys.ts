// The issuer writes these and every verifier reads them from the same Redis.
export const SESSION_EPOCH_KEY_PREFIX = 'auth:epoch:';
export const TOKEN_DENYLIST_KEY_PREFIX = 'auth:denylist:';
