import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { redisServiceWith } from '@shared/testing/redis-service.double';
import { SingleFlightLock } from './single-flight.lock';

const DOWN = new Error("Stream isn't writeable and enableOfflineQueue options is false");

function build() {
  const client = { set: vi.fn(), eval: vi.fn(), exists: vi.fn() };
  return { lock: new SingleFlightLock(redisServiceWith(client), fakePinoLogger()), client };
}

describe('SingleFlightLock', () => {
  // Waiting on a holder that cannot exist is wasted latency.
  it('tells a lock someone holds from an outage', async () => {
    const { lock, client } = build();
    client.set.mockResolvedValueOnce(null).mockRejectedValueOnce(DOWN);

    expect([await lock.acquire('k:lock', 5000), await lock.acquire('k:lock', 5000)]).toEqual([
      { status: 'held' },
      { status: 'error' },
    ]);
  });

  // A waiter must not be pinned by a lock it cannot see, and the lease expires on its own.
  it('fails open while Redis is unreachable', async () => {
    const { lock, client } = build();
    client.exists.mockRejectedValue(DOWN);
    client.eval.mockRejectedValue(DOWN);

    await expect(lock.isHeld('k:lock')).resolves.toBe(false);
    await expect(lock.release('k:lock', 'token-1')).resolves.toBeUndefined();
  });
});
