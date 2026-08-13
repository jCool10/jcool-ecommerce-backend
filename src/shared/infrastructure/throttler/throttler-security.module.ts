import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisService } from '../redis/redis.service';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { GLOBAL_THROTTLERS } from './throttler.constants';

/**
 * App-wide rate limiting (brute-force + DoS protection). Counters live in Redis
 * on the shared client, so limits hold across instances and process restarts
 * rather than per-process memory. Registered before AuthModule in AppModule so
 * its global guard runs ahead of the auth guards and floods are shed early.
 *
 * `THROTTLE_ENABLED=false` turns enforcement off via `skipIf` (used by the
 * default e2e harness and available as an operational kill-switch).
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => {
        const enabled = config.get<boolean>('throttle.enabled') !== false;
        return {
          throttlers: GLOBAL_THROTTLERS,
          errorMessage: 'Too many requests. Please try again later.',
          storage: new ThrottlerStorageRedisService(redis.getClient()),
          skipIf: () => !enabled,
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AccountAwareThrottlerGuard }],
})
export class ThrottlerSecurityModule {}
