import type { Redis } from 'ioredis';

const POLL_MS = 20;
const ATTEMPTS = 250;

/** The app's client rejects commands until ready (`enableOfflineQueue: false`), so wait it out. */
export async function waitForRedisReady(client: Redis): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS && client.status !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (client.status !== 'ready') {
    throw new Error(`Redis did not become ready: status=${client.status}`);
  }
}
