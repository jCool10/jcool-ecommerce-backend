import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { RedisService } from '@jcool/platform/redis';
import type { SessionEpochPublisherPort } from '../application/ports';

export const SESSION_EPOCH_KEY_PREFIX = 'auth:epoch:';

// SET-max in one round trip: a read-through fill racing a bump can land in either order and the key
// still ends at the larger epoch.
const RAISE_EPOCH = `
local current = tonumber(redis.call('GET', KEYS[1]))
local proposed = tonumber(ARGV[1])
if current ~= nil and current >= proposed then
  return current
end
redis.call('SET', KEYS[1], ARGV[1])
return proposed
`;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 25;

@Injectable()
export class RedisSessionEpochPublisher implements SessionEpochPublisherPort {
  constructor(private readonly redis: RedisService) {}

  async publish(userId: string, epoch: number): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        const published = await this.redis.getClient().eval(RAISE_EPOCH, 1, SESSION_EPOCH_KEY_PREFIX + userId, epoch);
        return Number(published);
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
        await sleep(BACKOFF_MS * attempt);
      }
    }
  }
}
