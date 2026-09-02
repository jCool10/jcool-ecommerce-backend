import type { Redis } from 'ioredis';

const POLL_MS = 20;
const ATTEMPTS = 250;

/**
 * Block until the client can actually take a command.
 *
 * ioredis connects lazily and the app's client runs with `enableOfflineQueue: false`, so a command
 * issued before the socket is writable is rejected outright rather than buffered. That is the
 * correct production behaviour — a cold cache read falls through to Postgres — but it makes any
 * assertion about caching or locking measure the fall-through path instead, purely on timing.
 */
export async function waitForRedisReady(client: Redis): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS && client.status !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (client.status !== 'ready') {
    throw new Error(`Redis did not become ready: status=${client.status}`);
  }
}
