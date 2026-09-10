import { hostname } from 'node:os';
import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bindIdentityClockMetrics,
  unbindIdentityClockMetrics,
} from '@shared/observability/metrics/identity-clock.collector';
import type { Pool } from 'pg';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { IdentityService } from './identity.service';
import { clearActiveLease, setActiveLease } from './lease/active-lease';
import { DRIZZLE_LEASE, LEASE_DB_PROVIDERS, LEASE_PG_POOL } from './lease/lease-db.provider';
import { DrizzleNodeIdLeaseRepository } from './lease/drizzle-node-id-lease.repository';
import { LeaseHolder } from './lease/lease-holder';
import { NODE_ID_LEASE, type NodeIdLeasePort } from './lease/node-id-lease.port';
import { parseServicePools, poolSizeFor } from './lease/service-pools';
import { UuidV8Generator } from './uuid-v8.generator';

/** A provider, not a constant at the construction site: the node id is now leased, and acquiring it
 * is the only asynchronous step in building the generator. */
export const IDENTITY_NODE_ID = Symbol('IDENTITY_NODE_ID');
export const LEASE_HOLDER = Symbol('LEASE_HOLDER');

// The same 5s the bucket-key verifier allows, and deliberately the opposite failure direction: that
// one fails open, because a slow database should not stop a boot that can still mint safely. This
// one cannot — without a node id there is no safe id to mint under — so the app restart-loops while
// Postgres is down where it previously started.
const ACQUIRE_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/**
 * The generator must stay a singleton: two instances share this process's node id and mint the same
 * `(timestamp, node, sequence)` triples, which nothing detects at runtime.
 */
@Module({
  providers: [
    ...LEASE_DB_PROVIDERS,
    {
      provide: NODE_ID_LEASE,
      inject: [DRIZZLE_LEASE, ConfigService],
      useFactory: (db: DrizzleDB, config: ConfigService): NodeIdLeasePort => {
        const pools = parseServicePools(config.getOrThrow<string>('identity.lease.pools'));
        // Before any statement: acquire seeds a pool on first contact, so an unknown name would
        // create one instead of failing.
        poolSizeFor(pools, config.getOrThrow<string>('identity.lease.service'));
        return new DrizzleNodeIdLeaseRepository(
          db,
          pools,
          config.getOrThrow<number>('identity.lease.ttlSeconds'),
          config.getOrThrow<number>('identity.lease.skewMs'),
        );
      },
    },
    {
      provide: LEASE_HOLDER,
      inject: [NODE_ID_LEASE, ConfigService],
      useFactory: (leases: NodeIdLeasePort, config: ConfigService): LeaseHolder => {
        const logger = new Logger('LeaseHolder');
        return new LeaseHolder(leases, {
          service: config.getOrThrow<string>('identity.lease.service'),
          holder: `${hostname()}#${process.pid}`,
          ttlSeconds: config.getOrThrow<number>('identity.lease.ttlSeconds'),
          skewMs: config.getOrThrow<number>('identity.lease.skewMs'),
          onLost: () => logger.error('Node-id lease lost; minting fenced and readiness going red'),
          onGiveUp: () => {
            logger.error('Node-id lease still lost after the grace window; exiting for a clean re-acquire');
            process.exit(1);
          },
        });
      },
    },
    {
      provide: IDENTITY_NODE_ID,
      inject: [LEASE_HOLDER],
      useFactory: (holder: LeaseHolder): Promise<number> =>
        withTimeout(holder.start(), ACQUIRE_TIMEOUT_MS, 'Node-id lease acquisition'),
    },
    {
      provide: UuidV8Generator,
      inject: [IDENTITY_NODE_ID, LEASE_HOLDER],
      useFactory: (nodeId: number, holder: LeaseHolder) => {
        const generator = UuidV8Generator.create({ nodeId });
        holder.attach(generator);
        // Per app, not per process: registered metrics outlive any one app.
        bindIdentityClockMetrics(generator);
        setActiveLease(holder);
        return generator;
      },
    },
    {
      provide: IdentityService,
      inject: [UuidV8Generator, ConfigService],
      useFactory: (generator: UuidV8Generator, config: ConfigService) =>
        new IdentityService(generator, config.getOrThrow<string>('identity.bucketKey')),
    },
  ],
  exports: [IdentityService, UuidV8Generator, LEASE_HOLDER],
})
export class IdentityModule implements OnApplicationShutdown {
  constructor(
    private readonly generator: UuidV8Generator,
    @Inject(LEASE_HOLDER) private readonly holder: LeaseHolder,
    @Inject(LEASE_PG_POOL) private readonly leasePool: Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    unbindIdentityClockMetrics(this.generator);
    clearActiveLease(this.holder);
    // Carries lastMs, so the next holder's reclaim guard reads the real high-water mark rather than
    // one a renewal interval old. Released before the pool closes, or the release never lands.
    await this.holder.stop();
    await this.leasePool.end();
  }
}
