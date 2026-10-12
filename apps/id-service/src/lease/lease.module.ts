import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import type { Etcd3 } from 'etcd3';
import { NodeLease } from '@jcool/id-generator';
import { IDENTITY_CLOCK_PROVIDERS } from '@jcool/platform/metrics';
import type { EtcdConfig, LeaseConfig } from '../config/configuration';
import { ETCD_CLIENT } from '../etcd/etcd-client';
import { EtcdLeaseStore } from './etcd-lease-store';
import { LeaseHealthIndicator } from './lease.health-indicator';
import { LeaseKeeper } from './lease-keeper.service';
import { LEASE_METRIC_PROVIDERS } from './lease.metrics';

// Not global on purpose: Nest runs a global module's shutdown hooks last, and the keeper's release
// must reach etcd before the global EtcdModule closes the client.
@Module({
  imports: [TerminusModule],
  providers: [
    {
      provide: EtcdLeaseStore,
      inject: [ETCD_CLIENT, ConfigService],
      useFactory: (etcd: Etcd3, config: ConfigService): EtcdLeaseStore =>
        new EtcdLeaseStore(etcd, config.getOrThrow<EtcdConfig>('etcd')),
    },
    {
      provide: NodeLease,
      inject: [ConfigService, EtcdLeaseStore],
      useFactory: (config: ConfigService, store: EtcdLeaseStore): NodeLease => {
        const { holder, ttlMs, fenceMarginMs, maxFloorAheadMs } = config.getOrThrow<LeaseConfig>('lease');
        return NodeLease.create({ store, holder, ttlMs, fenceMarginMs, maxFloorAheadMs });
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
