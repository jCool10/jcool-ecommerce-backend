import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { ID_SERVICE_BREAKER, IdServiceHttpAdapter, isIdServiceFault } from '@jcool/platform/identity';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { ID_GENERATOR, type IdGeneratorPort } from './id-generator.port';

@Global()
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
          { url: config.getOrThrow<string>('idService.url'), timeoutMs, caller: 'api' },
          breaker,
          cls,
        );
      },
    },
  ],
  exports: [ID_GENERATOR],
})
export class IdentityModule {}
