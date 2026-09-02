import { Module } from '@nestjs/common';
import { CircuitBreakerFactory } from './circuit-breaker.factory';

// Not @Global: a context opts into breaker protection by importing this, so the set of guarded
// dependencies stays visible in the wiring. METRICS comes from the global MetricsModule.
@Module({
  providers: [CircuitBreakerFactory],
  exports: [CircuitBreakerFactory],
})
export class ResilienceModule {}
