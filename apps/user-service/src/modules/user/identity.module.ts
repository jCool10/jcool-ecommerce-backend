import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { ID_GENERATOR, type IdGeneratorPort } from './application/ports';
import { IdentityService } from './application/services/identity.service';
import { ID_SERVICE_BREAKER, IdServiceHttpAdapter, isIdServiceFault } from './infrastructure/id-service.http-adapter';

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
        return new IdServiceHttpAdapter({ url: config.getOrThrow<string>('idService.url'), timeoutMs }, breaker, cls);
      },
    },
    {
      provide: IdentityService,
      inject: [ID_GENERATOR, ConfigService],
      useFactory: (ids: IdGeneratorPort, config: ConfigService) =>
        new IdentityService(ids, config.getOrThrow<string>('identity.bucketKey')),
    },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
