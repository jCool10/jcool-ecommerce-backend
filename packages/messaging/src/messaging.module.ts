import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { InboxStore } from './inbox/inbox.store';
import { SweepInbox } from './inbox/sweep-inbox';
import type { MessagingModuleOptions } from './messaging.options';
import { MESSAGING_CONSUMERS, MESSAGING_ID_GENERATOR, MESSAGING_OPTIONS } from './messaging.tokens';
import { DrizzleOutboxWriter } from './outbox/drizzle-outbox.writer';
import { OUTBOX_BACKLOG_PROVIDERS } from './outbox/outbox-backlog.collector';
import { OutboxRelay } from './outbox/outbox-relay';
import { OutboxRelayScheduler } from './outbox/outbox-relay.scheduler';
import { SweepPublishedOutbox } from './outbox/sweep-published-outbox';
import { OUTBOX_WRITER } from './outbox-port';
import { DeadLetterRouter } from './queue/dead-letter';
import { DomainEventProcessor } from './queue/domain-event.processor';
import { DomainEventsWorker } from './queue/domain-events.worker';
import type { Consumers, DomainEventDispatcherPort, QueueDefinition } from './queue/queue-definition';
import { QUEUE_DEPTH_COLLECTOR_PROVIDERS } from './queue/queue-depth.collector';
import { QueueLifecycle } from './queue/queue.lifecycle';
import { queueProviders } from './queue/queue.providers';

@Module({})
export class MessagingModule {
  /**
   * Global because any context may need to emit an event. Only the writer is exported: a raw Queue
   * in a global module would let any context publish straight to it — the dual-write the outbox
   * exists to prevent.
   */
  static forRoot(options: MessagingModuleOptions): DynamicModule {
    assertDistinct(options.queues);

    const consumerProviders: Provider[] =
      options.queues.length === 0
        ? []
        : [
            ...QUEUE_DEPTH_COLLECTOR_PROVIDERS,
            InboxStore,
            SweepInbox,
            DomainEventProcessor,
            DeadLetterRouter,
            DomainEventsWorker,
          ];

    return {
      module: MessagingModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: MESSAGING_OPTIONS, useValue: options },
        { provide: MESSAGING_ID_GENERATOR, useExisting: options.idGenerator },
        {
          provide: MESSAGING_CONSUMERS,
          inject: options.queues.map((definition) => definition.dispatcher),
          useFactory: (...dispatchers: DomainEventDispatcherPort[]): Consumers =>
            new Map(
              options.queues.map((definition, i) => [definition.name, { definition, dispatcher: dispatchers[i] }]),
            ),
        },
        { provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter },
        ...queueProviders(options.routes, options.queues),
        ...OUTBOX_BACKLOG_PROVIDERS,
        QueueLifecycle,
        OutboxRelay,
        OutboxRelayScheduler,
        SweepPublishedOutbox,
        ...consumerProviders,
        ...(options.providers ?? []),
      ],
      exports: [OUTBOX_WRITER],
    };
  }
}

// Two queues on one consumer group would dedup each other's messages away in the shared inbox.
function assertDistinct(queues: QueueDefinition[]): void {
  for (const key of ['name', 'consumer'] as const) {
    const seen = new Set<string>();
    for (const definition of queues) {
      if (seen.has(definition[key])) throw new Error(`two consumed queues share the ${key} ${definition[key]}`);
      seen.add(definition[key]);
    }
  }
}
