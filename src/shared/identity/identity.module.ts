import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bindIdentityClockMetrics,
  unbindIdentityClockMetrics,
} from '@shared/observability/metrics/identity-clock.collector';
import { IdentityService } from './identity.service';
import { APP_NODE_ID } from './node-ids';
import { UuidV8Generator } from './uuid-v8.generator';

/**
 * The node id this process mints under. It is a provider rather than a constant read at the
 * construction site so that replacing it — with a leased id, once more than one writer exists — is a
 * one-provider change: nothing downstream of the generator names a node id.
 */
export const IDENTITY_NODE_ID = Symbol('IDENTITY_NODE_ID');

/**
 * Wires the id generator and the bucket policy into DI, deliberately outside the `identity` barrel:
 * that barrel is imported for `bucketOf` alone in places that must not drag Nest and config along.
 *
 * The generator is a singleton by construction, and must stay one — two instances in a process hold
 * the same node id and mint the same `(timestamp, node, sequence)` triples, which nothing here or in
 * the generator detects.
 */
@Module({
  providers: [
    { provide: IDENTITY_NODE_ID, useValue: APP_NODE_ID },
    {
      provide: UuidV8Generator,
      inject: [IDENTITY_NODE_ID],
      useFactory: (nodeId: number) => {
        const generator = UuidV8Generator.create({ nodeId });
        // Point the clock gauges at this generator. Registered metrics outlive any one app, so the
        // binding has to happen per app rather than once per process.
        bindIdentityClockMetrics(generator);
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
  exports: [IdentityService, UuidV8Generator],
})
export class IdentityModule implements OnApplicationShutdown {
  constructor(private readonly generator: UuidV8Generator) {}

  onApplicationShutdown(): void {
    unbindIdentityClockMetrics(this.generator);
  }
}
