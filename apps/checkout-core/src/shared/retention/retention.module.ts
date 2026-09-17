import { Global, Module } from '@nestjs/common';
import { RetentionSweepRegistry } from './retention-sweep.registry';
import { RetentionScheduler } from './retention.scheduler';

// Global because most contexts own a sweep. Only the registry is exported: a caller able to reach
// the scheduler could drive a DELETE from a request.
@Global()
@Module({
  providers: [RetentionSweepRegistry, RetentionScheduler],
  exports: [RetentionSweepRegistry],
})
export class RetentionModule {}
