import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { NodeLease } from '@jcool/id-generator';
import { IDENTITY_CLOCK_PROVIDERS } from '@jcool/platform/metrics';
import type { LeaseConfig } from '../config/configuration';
import { LeaseHealthIndicator } from './lease.health-indicator';
import { LeaseKeeper } from './lease-keeper.service';
import { LEASE_METRIC_PROVIDERS } from './lease.metrics';
import { PostgresLeaseStore } from './postgres-lease-store';

// Not global on purpose: Nest runs a global module's shutdown hooks last, and the keeper's release
// must reach Postgres before the global DrizzleModule ends the pool.
@Module({
  imports: [TerminusModule],
  providers: [
    PostgresLeaseStore,
    {
      provide: NodeLease,
      inject: [ConfigService, PostgresLeaseStore],
      useFactory: (config: ConfigService, store: PostgresLeaseStore): NodeLease => {
        const { holder, ttlMs, quarantineMs, fenceMarginMs, maxFloorAheadMs } = config.getOrThrow<LeaseConfig>('lease');
        return NodeLease.create({ store, holder, ttlMs, quarantineMs, fenceMarginMs, maxFloorAheadMs });
      },
    },
    LeaseKeeper,
    LeaseHealthIndicator,
    ...LEASE_METRIC_PROVIDERS,
    ...IDENTITY_CLOCK_PROVIDERS,
  ],
  exports: [NodeLease, LeaseHealthIndicator],
})
export class LeaseModule {}
