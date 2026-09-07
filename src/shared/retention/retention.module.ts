import { Global, Module } from '@nestjs/common';
import { RetentionSweepRegistry } from './retention-sweep.registry';
import { RetentionScheduler } from './retention.scheduler';

/**
 * The one timer that drives every table's reclamation, plus the registry the contexts register into.
 *
 * Global for the same reason as MessagingModule and MetricsModule — most contexts own a sweep.
 * Only the registry is exported: a caller able to reach the scheduler could drive a DELETE from a
 * request.
 */
@Global()
@Module({
  providers: [RetentionSweepRegistry, RetentionScheduler],
  exports: [RetentionSweepRegistry],
})
export class RetentionModule {}
