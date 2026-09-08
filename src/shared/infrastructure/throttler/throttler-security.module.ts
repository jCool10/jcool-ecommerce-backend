import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisService } from '../redis';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { GLOBAL_THROTTLERS } from './throttler.constants';

// Counters live in shared Redis so limits hold across instances and restarts. Registered before
// AuthModule so this global guard sheds floods ahead of the auth guards — which is also why the
// per-user tier can't be global; UserThrottlerGuard carries it per route, after authentication.
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
