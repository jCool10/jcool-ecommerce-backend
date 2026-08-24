import { Global, Module } from '@nestjs/common';
import { DrizzleOutboxWriter } from './outbox/drizzle-outbox.writer';
import { OutboxRelay } from './outbox/outbox-relay';
import { OutboxRelayScheduler } from './outbox/outbox-relay.scheduler';
import { OUTBOX_WRITER } from './outbox/outbox-writer.port';
import { QueueLifecycle } from './queue/queue.lifecycle';
import { QUEUE_PROVIDERS } from './queue/queue.providers';

/**
 * Messaging infrastructure (ADR 0019). Global because any context may need to emit an event, and
 * the writer holds no per-module state — the same reasoning as MetricsModule.
 */
@Global()
@Module({
  // The queue token stays unexported on purpose: the relay lives in this package, and exporting the
  // raw Queue from a @Global module would let any context publish straight to it — the dual-write
  // the outbox exists to prevent, and one the architecture rules would not catch.
  providers: [
    { provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter },
    ...QUEUE_PROVIDERS,
    QueueLifecycle,
    OutboxRelay,
    OutboxRelayScheduler,
  ],
  exports: [OUTBOX_WRITER],
})
export class MessagingModule {}
