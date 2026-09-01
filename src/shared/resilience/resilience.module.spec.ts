import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import configuration from '@shared/config/configuration';
import { METRICS } from '@shared/observability/metrics/metrics.port';
import { CircuitBreakerFactory } from './circuit-breaker.factory';
import { ResilienceModule } from './resilience.module';

// Mirrors the real MetricsModule, which is global — the factory injects METRICS without importing it.
@Global()
@Module({
  providers: [
    {
      provide: METRICS,
      useValue: { setBreakerState: vi.fn(), recordBreakerTransition: vi.fn(), recordBreakerCall: vi.fn() },
    },
  ],
  exports: [METRICS],
})
class FakeMetricsModule {}

describe('ResilienceModule', () => {
  it('resolves the factory against the shipped configuration', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ load: [configuration], ignoreEnvFile: true, isGlobal: true }),
        FakeMetricsModule,
        ResilienceModule,
      ],
    }).compile();
    const app = await moduleRef.createNestApplication().init();

    // Every breaker option is read with getOrThrow in the constructor, so resolving the provider is
    // what proves the six keys are spelled the same here and in configuration.ts.
    const call = app.get(CircuitBreakerFactory).create('probe');
    await expect(call.run(() => Promise.resolve('ok'))).resolves.toBe('ok');

    await app.close();
  });
});
