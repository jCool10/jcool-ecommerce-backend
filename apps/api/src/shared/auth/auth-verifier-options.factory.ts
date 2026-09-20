import type { ConfigService } from '@nestjs/config';
import { type JSONWebKeySet, type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, errors } from 'jose';
import type { AuthVerifierOptions } from '@jcool/auth-verifier';

// How long a failed fetch leaves the endpoint alone, so an outage costs one timeout, not one per request.
const RETRY_AFTER_FAILURE_MS = 30_000;

/** The user-service's JWKS is the only key source; the env schema requires it. */
export function authVerifierOptions(config: ConfigService): AuthVerifierOptions {
  return {
    es256: {
      keys: jwksServingStale(
        new URL(config.getOrThrow<string>('auth.jwksUrl')),
        config.getOrThrow<number>('userService.timeoutMs'),
      ),
      issuer: config.getOrThrow<string>('auth.issuer'),
      audience: config.getOrThrow<string>('auth.audience'),
    },
  };
}

/**
 * jose refetches once its 10-minute cache is stale and throws if that fails, which would refuse every
 * ES256 token for as long as the JWKS is unreachable. Falling back to the last set that loaded keeps
 * the keys already trusted; a key dropped from the set still stops verifying on the first fetch that
 * succeeds.
 */
function jwksServingStale(url: URL, timeoutMs: number): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(url, { timeoutDuration: timeoutMs });
  let failedAt = -Infinity;
  let local: { set: JSONWebKeySet; keys: JWTVerifyGetKey } | undefined;

  const fromLastSet = (set: JSONWebKeySet): JWTVerifyGetKey => {
    if (local?.set !== set) local = { set, keys: createLocalJWKSet(set) };
    return local.keys;
  };

  return async (header, token) => {
    const known = remote.jwks();
    if (known && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return fromLastSet(known)(header, token);
    try {
      return await remote(header, token);
    } catch (error) {
      const stale = remote.jwks();
      if (!stale || error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw error;
      }
      failedAt = Date.now();
      return fromLastSet(stale)(header, token);
    }
  };
}
