import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { ID_SERVICE_BREAKER, IdServiceHttpAdapter, isIdServiceFault } from '@jcool/platform/identity';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { ID_GENERATOR, type IdGeneratorPort } from './application/ports';
import { IdGeneratorService } from './application/services/id-generator.service';

/**
 * Every id comes from the id service. There is deliberately no in-process generator here: one would
 * mint on a node id the fleet already uses.
 */
@Module({
  imports: [ResilienceModule],
  providers: [
    {
      provide: ID_GENERATOR,
      inject: [ConfigService, CircuitBreakerFactory, ClsService],
      useFactory: (config: ConfigService, breakers: CircuitBreakerFactory, cls: ClsService): IdGeneratorPort => {
        const timeoutMs = config.getOrThrow<number>('idService.timeoutMs');
        const breaker = breakers.create(ID_SERVICE_BREAKER, { timeoutMs, isDownstreamFault: isIdServiceFault });
        return new IdServiceHttpAdapter(
          { url: config.getOrThrow<string>('idService.url'), timeoutMs, caller: 'user-service' },
          breaker,
          cls,
        );
      },
    },
    {
      provide: IdGeneratorService,
      inject: [ID_GENERATOR],
      useFactory: (ids: IdGeneratorPort) => new IdGeneratorService(ids),
    },
  ],
  exports: [IdGeneratorService],
})
export class IdentityModule {}
