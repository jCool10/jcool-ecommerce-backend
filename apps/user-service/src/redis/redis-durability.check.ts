import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '@jcool/platform/redis';

const READY_TIMEOUT_MS = 10_000;

const LOG_CONTEXT = 'RedisDurabilityCheck';

/**
 * `auth:epoch:*` is revocation state with no other copy outside Postgres: an evicted or un-persisted
 * key is a revoked session accepted elsewhere until the reconciler catches up. Read through INFO,
 * because managed Redis commonly disables CONFIG.
 */
@Injectable()
export class RedisDurabilityCheck implements OnModuleInit {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async onModuleInit(): Promise<void> {
    const client = this.redis.getClient();
    await whenReady(client, READY_TIMEOUT_MS);

    const info = await client.info();
    const policy = infoField(info, 'maxmemory_policy');
    const problems: string[] = [];
    if (policy !== 'noeviction') problems.push(`maxmemory-policy is ${policy ?? 'unreported'}, not noeviction`);
    if (infoField(info, 'aof_enabled') !== '1') problems.push('appendonly is off');

    if (problems.length > 0) {
      throw new Error(`Redis cannot hold auth state: ${problems.join('; ')}. See RUNBOOK.md, "Redis durability".`);
    }
    this.logger.info('redis durability verified: noeviction, appendonly');
  }
}

// The platform client rejects commands while disconnected rather than queueing them.
function whenReady(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis was not ready within ${timeoutMs}ms`));
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

function infoField(info: string, name: string): string | undefined {
  return new RegExp(`^${name}:(.*)$`, 'm').exec(info)?.[1]?.trim();
}
