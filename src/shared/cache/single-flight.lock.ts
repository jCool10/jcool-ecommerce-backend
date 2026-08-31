import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@shared/infrastructure/redis';

/**
 * Outcome of one acquire. `held` (someone else is rebuilding) and `error` (Redis unreachable) are
 * kept apart because they call for opposite reactions: wait for the other holder's value, or stop
 * involving Redis at all and read through to the source.
 */
export type LockAttempt = { status: 'acquired'; token: string } | { status: 'held' } | { status: 'error' };

// Compare-then-delete, atomically. A plain DEL would release whatever lock is there — including the
// one a second holder legitimately took after this holder's lease expired mid-rebuild.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/**
 * Mutual exclusion for cache rebuilds: one holder per key refills from the source while the rest
 * wait or serve stale, so an expiring hot key costs one query instead of one per request.
 *
 * Lease-bounded rather than absolute — a holder that crashes cannot wedge the key, at the price of
 * a rare second rebuild when a lease expires under a slower-than-expected source.
 */
@Injectable()
export class SingleFlightLock {
  private readonly logger = new Logger(SingleFlightLock.name);

  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, leaseMs: number): Promise<LockAttempt> {
    const token = randomUUID();
    try {
      const outcome = await this.redis.getClient().set(key, token, 'PX', leaseMs, 'NX');
      return outcome === 'OK' ? { status: 'acquired', token } : { status: 'held' };
    } catch (caught) {
      this.warn('acquire', key, caught);
      return { status: 'error' };
    }
  }

  /** Best-effort: a release that never lands only delays the next rebuild until the lease expires. */
  async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.getClient().eval(RELEASE_SCRIPT, 1, key, token);
    } catch (caught) {
      this.warn('release', key, caught);
    }
  }

  private warn(op: string, key: string, caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    this.logger.warn(`single-flight ${op} failed for "${key}": ${message}`);
  }
}
