import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bindIdentityClockMetrics,
  unbindIdentityClockMetrics,
} from '@shared/observability/metrics/identity-clock.collector';
import { IdentityService } from './identity.service';
import { APP_NODE_ID } from './node-ids';
import { UuidV8Generator } from './uuid-v8.generator';

/** A provider, not a constant at the construction site, so swapping in a leased id later is a one-provider change. */
export const IDENTITY_NODE_ID = Symbol('IDENTITY_NODE_ID');

/**
 * DI wiring, kept outside the `identity` barrel so a caller that only wants `bucketOf` does not drag
 * Nest and config along.
 *
 * The generator must stay a singleton: two instances share this process's node id and mint the same
 * `(timestamp, node, sequence)` triples, which nothing detects at runtime.
 */
@Module({
  providers: [
    { provide: IDENTITY_NODE_ID, useValue: APP_NODE_ID },
    {
      provide: UuidV8Generator,
      inject: [IDENTITY_NODE_ID],
      useFactory: (nodeId: number) => {
        const generator = UuidV8Generator.create({ nodeId });
        // Per app, not per process: registered metrics outlive any one app.
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
