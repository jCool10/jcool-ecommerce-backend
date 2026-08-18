import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisService } from '../redis';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { GLOBAL_THROTTLERS } from './throttler.constants';

/** App-wide rate limiting (brute-force + DoS) with counters in shared Redis so limits hold across instances and restarts; registered before AuthModule so its global guard sheds floods ahead of the auth guards. `THROTTLE_ENABLED=false` turns enforcement off in AccountAwareThrottlerGuard. See docs/engineering-notes.md (Auth — Rate limiting / brute-force protection). */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: GLOBAL_THROTTLERS,
        errorMessage: 'Too many requests. Please try again later.',
        storage: new ThrottlerStorageRedisService(redis.getClient()),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AccountAwareThrottlerGuard }],
})
export class ThrottlerSecurityModule {}
