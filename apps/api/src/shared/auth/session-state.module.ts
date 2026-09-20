import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESSION_EPOCH, TOKEN_DENYLIST } from '@jcool/auth-verifier';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { RedisService } from '@jcool/platform/redis';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { createUserServiceClient } from '@shared/user-service/user-service.client';
import { RedisSessionEpochReader, RedisTokenDenylistReader } from './redis-session-state.readers';

/** What the token verifier reads. The user-service owns every write to these keys. */
@Module({
  imports: [ResilienceModule],
  providers: [
    {
      provide: SESSION_EPOCH,
      inject: [ConfigService, RedisService, CircuitBreakerFactory, METRICS],
      useFactory: (config: ConfigService, redis: RedisService, breakers: CircuitBreakerFactory, metrics: MetricsPort) =>
        new RedisSessionEpochReader(redis, createUserServiceClient(config, breakers), metrics),
    },
    {
      provide: TOKEN_DENYLIST,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new RedisTokenDenylistReader(redis),
    },
  ],
  exports: [SESSION_EPOCH, TOKEN_DENYLIST],
})
export class SessionStateModule {}
