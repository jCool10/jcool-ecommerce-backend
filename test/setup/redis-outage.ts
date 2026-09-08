import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { waitForRedisReady } from './redis-ready';

/**
 * The restore is tolerant on purpose: ioredis may already be re-establishing the socket, and a
 * blind `connect()` would reject with "already connecting/connected" and fail a passing test.
 */
export async function withRedisDown(app: INestApplication, run: () => Promise<void>): Promise<void> {
  return withClientDown(app.get(RedisService).getClient(), run);
}

/** For a client the app holds under a different token — the queue keeps its own. */
export async function withClientDown(client: Redis, run: () => Promise<void>): Promise<void> {
  client.disconnect();
  try {
    await run();
  } finally {
    if (client.status === 'end' || client.status === 'close') {
      await client.connect();
    }
    await waitForRedisReady(client);
  }
}
