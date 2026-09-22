import { ServiceUnavailableException } from '@nestjs/common';
import {
  SESSION_EPOCH_KEY_PREFIX,
  type SessionEpochReader,
  TOKEN_DENYLIST_KEY_PREFIX,
  type TokenDenylistReader,
} from '@jcool/auth-verifier';
import type { MetricsPort } from '@jcool/metrics-port';
import type { RedisService } from '@jcool/platform/redis';
import type { UserServiceClient } from '@shared/user-service/user-service.client';

const WHOLE_NUMBER = /^\d+$/;

/**
 * Read-only by construction: the user-service owns these keys and fills a missing one with a SET-max,
 * so a write from here could race a bump and lower an epoch.
 */
export class RedisSessionEpochReader implements SessionEpochReader {
  constructor(
    private readonly redis: RedisService,
    private readonly userService: Pick<UserServiceClient, 'sessionEpoch'>,
    private readonly metrics: MetricsPort,
  ) {}

  async current(userId: string): Promise<number | null> {
    const stored = await this.redis.getClient().get(SESSION_EPOCH_KEY_PREFIX + userId);
    if (stored !== null) {
      this.metrics.recordSessionEpochLookup('hit');
      if (!WHOLE_NUMBER.test(stored)) throw new Error(`session epoch for ${userId} is not a whole number`);
      return Number(stored);
    }

    this.metrics.recordSessionEpochLookup('miss');
    try {
      return await this.userService.sessionEpoch(userId);
    } catch (error) {
      throw new ServiceUnavailableException('Service unavailable', { cause: error });
    }
  }
}

export class RedisTokenDenylistReader implements TokenDenylistReader {
  constructor(private readonly redis: RedisService) {}

  async isDenylisted(jti: string): Promise<boolean> {
    return (await this.redis.getClient().exists(TOKEN_DENYLIST_KEY_PREFIX + jti)) === 1;
  }
}
