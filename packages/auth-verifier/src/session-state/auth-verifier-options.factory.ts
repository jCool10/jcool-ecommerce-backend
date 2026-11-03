import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { type JSONWebKeySet, type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, errors } from 'jose';
import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import type { AuthVerifierOptions } from '../auth-verifier.options';

const LOG_CONTEXT = 'AuthVerifierOptions';

// How long a failed fetch leaves the endpoint alone, so an outage costs one timeout, not one per request.
const RETRY_AFTER_FAILURE_MS = 30_000;

/** The user-service's JWKS is the only key source; the env schema requires it. */
export function authVerifierOptions(config: ConfigService, logger: PinoLogger): AuthVerifierOptions {
  return {
    es256: {
      keys: jwksServingStale(
        new URL(config.getOrThrow<string>('auth.jwksUrl')),
        config.getOrThrow<number>('userService.timeoutMs'),
        logger,
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
 * succeeds. With no set ever loaded (the api booting while the user-service is down) there is nothing
 * to fall back to, and the lookup fails with a 503.
 */
function jwksServingStale(url: URL, timeoutMs: number, logger: PinoLogger): JWTVerifyGetKey {
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
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw error;
      }
      const stale = remote.jwks();
      if (!stale) {
        // Nothing was ever loaded, so no token could be judged: that is this service's outage, not
        // a bad credential, and a 401 would send every client back through login.
        throw new ServiceUnavailableException('Service unavailable', { cause: error });
      }
      // Concurrent callers share jose's one pending fetch, so a single failure lands here once per caller.
      const alreadyReported = Date.now() - failedAt < RETRY_AFTER_FAILURE_MS;
      failedAt = Date.now();
      if (!alreadyReported) {
        logger.warn({ context: LOG_CONTEXT, err: toError(error) }, 'jwks refetch failed, serving cached keys');
      }
      return fromLastSet(stale)(header, token);
    }
  };
}
