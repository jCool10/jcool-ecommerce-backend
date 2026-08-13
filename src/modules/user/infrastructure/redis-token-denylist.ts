import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../shared/infrastructure/redis/redis.service';
import type { TokenDenylistPort } from '../application/ports/token-denylist.port';

// Redis adapter for the access-token denylist: one key per denylisted jti with a PX TTL
// equal to the token's remaining life, so the denylist self-trims and never outgrows the live-token set.
const KEY_PREFIX = 'auth:denylist:';

@Injectable()
export class RedisTokenDenylist implements TokenDenylistPort {
  constructor(private readonly redis: RedisService) {}

  async denylist(jti: string, expiresAt: Date): Promise<void> {
    const ttlMs = expiresAt.getTime() - Date.now();
    // Already expired → the token is dead on its own; nothing to deny.
    if (ttlMs <= 0) {
      return;
    }
    await this.redis.getClient().set(`${KEY_PREFIX}${jti}`, '1', 'PX', ttlMs);
  }

  async isDenylisted(jti: string): Promise<boolean> {
    return (await this.redis.getClient().exists(`${KEY_PREFIX}${jti}`)) === 1;
  }
}
