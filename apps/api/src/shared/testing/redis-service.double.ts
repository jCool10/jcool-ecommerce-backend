import type { RedisService } from '@jcool/platform/redis';

/** A RedisService whose client is the given object, typed only by the commands a spec stubs. */
export const redisServiceWith = (client: object): RedisService =>
  ({ getClient: () => client }) as unknown as RedisService;
