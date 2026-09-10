import { Global, Module } from '@nestjs/common';
import { InboxStore } from './inbox/inbox.store';
import { SweepInbox } from './inbox/sweep-inbox';
import { DrizzleOutboxWriter } from './outbox/drizzle-outbox.writer';
import { SweepPublishedOutbox } from './outbox/sweep-published-outbox';
import { OutboxRelay } from './outbox/outbox-relay';
import { OutboxRelayScheduler } from './outbox/outbox-relay.scheduler';
import { OUTBOX_WRITER } from './outbox/outbox-writer.port';
import { DeadLetterRouter } from './queue/dead-letter';
import { DomainEventProcessor } from './queue/domain-event.processor';
import { DomainEventsWorker } from './queue/domain-events.worker';
import { QueueLifecycle } from './queue/queue.lifecycle';
import { QUEUE_PROVIDERS } from './queue/queue.providers';

// Global because any context may need to emit an event and the writer holds no per-module state.
@Global()
@Module({
  // No context imports here on purpose: this package is transport, and the effects an event applies
  // belong to an app. The app supplies them through DOMAIN_EVENT_DISPATCHER and EVENT_LABEL_REGISTRY
  // — see apps/commerce-core/src/messaging/commerce-messaging.module.ts. Without that inversion the
  // relay and the processor, which stay here, would drag order/ and payment/ into a library.
  // The queue token stays unexported on purpose: exporting the raw Queue from a @Global module would
  // let any context publish straight to it — the dual-write the outbox exists to prevent, and one
  // the architecture rules would not catch.
  providers: [
    { provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter },
    ...QUEUE_PROVIDERS,
    QueueLifecycle,
    OutboxRelay,
    OutboxRelayScheduler,
    InboxStore,
    SweepPublishedOutbox,
    SweepInbox,
    DomainEventProcessor,
    DeadLetterRouter,
    DomainEventsWorker,
  ],
  exports: [OUTBOX_WRITER],
})
export class MessagingModule {}
