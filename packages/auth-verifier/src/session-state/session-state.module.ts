import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { RedisService } from '@jcool/platform/redis';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { SESSION_EPOCH } from '../session-epoch.port';
import { TOKEN_DENYLIST } from '../token-denylist.port';
import { RedisSessionEpochReader, RedisTokenDenylistReader } from './redis-session-state.readers';
import { createUserServiceClient } from './user-service.client';

/** What the token verifier reads. The user-service owns every write to these keys. */
@Module({
  imports: [ResilienceModule],
  providers: [
    {
      provide: SESSION_EPOCH,
      inject: [ConfigService, RedisService, CircuitBreakerFactory, METRICS, ClsService],
      useFactory: (
        config: ConfigService,
        redis: RedisService,
        breakers: CircuitBreakerFactory,
        metrics: MetricsPort,
        cls: ClsService,
      ) => new RedisSessionEpochReader(redis, createUserServiceClient(config, breakers, cls), metrics),
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
