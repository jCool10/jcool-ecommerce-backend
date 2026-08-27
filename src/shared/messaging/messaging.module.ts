import { Global, Module } from '@nestjs/common';
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { DomainEventDispatcher } from './handlers/domain-event.dispatcher';
import { OrderEventsHandler } from './handlers/order-events.handler';
import { InboxStore } from './inbox/inbox.store';
import { DrizzleOutboxWriter } from './outbox/drizzle-outbox.writer';
import { OutboxRelay } from './outbox/outbox-relay';
import { OutboxRelayScheduler } from './outbox/outbox-relay.scheduler';
import { OUTBOX_WRITER } from './outbox/outbox-writer.port';
import { DeadLetterRouter } from './queue/dead-letter';
import { DomainEventProcessor } from './queue/domain-event.processor';
import { DomainEventsWorker } from './queue/domain-events.worker';
import { QueueLifecycle } from './queue/queue.lifecycle';
import { QUEUE_PROVIDERS } from './queue/queue.providers';

/**
 * Messaging infrastructure (ADR 0019). Global because any context may need to emit an event, and
 * the writer holds no per-module state — the same reasoning as MetricsModule.
 */
@Global()
@Module({
  // The consumer's effects belong to the contexts that own them, so this reaches into Order and
  // Payment for their handlers rather than reimplementing a settle here. One-way: neither imports
  // this module — both read the outbox port off the global export — so the graph stays acyclic.
  imports: [OrderModule, PaymentModule],
  // The queue token stays unexported on purpose: the relay lives in this package, and exporting the
  // raw Queue from a @Global module would let any context publish straight to it — the dual-write
  // the outbox exists to prevent, and one the architecture rules would not catch.
  providers: [
    { provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter },
    ...QUEUE_PROVIDERS,
    QueueLifecycle,
    OutboxRelay,
    OutboxRelayScheduler,
    InboxStore,
    OrderEventsHandler,
    DomainEventDispatcher,
    DomainEventProcessor,
    DeadLetterRouter,
    DomainEventsWorker,
  ],
  exports: [OUTBOX_WRITER],
})
export class MessagingModule {}
