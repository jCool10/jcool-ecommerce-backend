import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisService } from '../redis/redis.service';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { GLOBAL_THROTTLERS } from './throttler.constants';

/** App-wide rate limiting (brute-force + DoS) with counters in shared Redis so limits hold across instances and restarts; registered before AuthModule so its global guard sheds floods ahead of the auth guards, and `THROTTLE_ENABLED=false` turns enforcement off via `skipIf`. See docs/engineering-notes.md (Auth — Rate limiting / brute-force protection). */
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
