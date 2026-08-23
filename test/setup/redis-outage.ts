import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../../src/shared/infrastructure/redis';

/**
 * Take Redis away for the duration of `run`, then hand the suite back a usable client.
 *
 * The restore is tolerant on purpose: ioredis may already be re-establishing the socket by then,
 * and a blind `connect()` would reject with "already connecting/connected" and fail an otherwise
 * passing test.
 */
export async function withRedisDown(app: INestApplication, run: () => Promise<void>): Promise<void> {
  const client = app.get(RedisService).getClient();
  client.disconnect();
  try {
    await run();
  } finally {
    if (client.status === 'end' || client.status === 'close') {
      await client.connect();
    }
    await waitForReady(client);
  }
}

async function waitForReady(client: Redis): Promise<void> {
  for (let attempt = 0; attempt < 100 && client.status !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (client.status !== 'ready') {
    throw new Error(`Redis did not recover: status=${client.status}`);
  }
}
