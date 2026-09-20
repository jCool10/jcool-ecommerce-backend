import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESSION_EPOCH, type SessionEpochReader, TOKEN_DENYLIST } from '@jcool/auth-verifier';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { RedisService } from '@jcool/platform/redis';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { RedisSessionEpochReader, RedisTokenDenylistReader } from '@shared/auth/redis-session-state.readers';
import { createUserServiceClient } from '@shared/user-service/user-service.client';
import { DrizzleSessionEpochRepository } from './infrastructure/drizzle-session-epoch.repository';

/**
 * What the token verifier reads. The legacy auth flows keep their own writable bindings in
 * AuthModule; in `redis` mode the user-service owns every write.
 */
@Module({
  imports: [ResilienceModule],
  providers: [
    DrizzleSessionEpochRepository,
    {
      provide: SESSION_EPOCH,
      inject: [ConfigService, DrizzleSessionEpochRepository, RedisService, CircuitBreakerFactory, METRICS],
      useFactory: (
        config: ConfigService,
        database: DrizzleSessionEpochRepository,
        redis: RedisService,
        breakers: CircuitBreakerFactory,
        metrics: MetricsPort,
      ): SessionEpochReader =>
        config.getOrThrow<string>('auth.epochSource') === 'redis'
          ? new RedisSessionEpochReader(redis, createUserServiceClient(config, breakers), metrics)
          : database,
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
