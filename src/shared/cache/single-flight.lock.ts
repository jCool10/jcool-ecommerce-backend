import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '@shared/infrastructure/redis';

const LOG_CONTEXT = 'SingleFlightLock';

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
 * One holder per key refills from the source while the rest wait or serve stale. Lease-bounded
 * rather than absolute — a holder that crashes cannot wedge the key, at the price of a rare second
 * rebuild when a lease expires under a slower-than-expected source.
 */
@Injectable()
export class SingleFlightLock {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {}

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

  /**
   * Whether some holder is still rebuilding. A Redis failure answers `false`: a waiter must never be
   * pinned to a lock it cannot see.
   */
  async isHeld(key: string): Promise<boolean> {
    try {
      return (await this.redis.getClient().exists(key)) === 1;
    } catch (caught) {
      this.warn('exists', key, caught);
      return false;
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
    const reason = caught instanceof Error ? caught.message : String(caught);
    this.logger.warn({ context: LOG_CONTEXT, op, key, reason }, 'single-flight lock operation failed');
  }
}
