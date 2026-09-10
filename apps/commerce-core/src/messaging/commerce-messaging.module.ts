import { Global, Module } from '@nestjs/common';
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { DOMAIN_EVENT_DISPATCHER, EVENT_LABEL_REGISTRY } from '@shared/messaging/queue/domain-event-dispatcher.port';
import { DomainEventDispatcher } from './domain-event.dispatcher';
import { OrderEventsHandler } from './order-events.handler';

/**
 * The half of the messaging wiring that knows this app's contexts: the dispatch table and the
 * handlers it folds together. `MessagingModule` (the transport) stays context-free and reaches this
 * through two tokens, which is what lets the relay, the processor and the dead-letter router live in
 * a library that no app owns.
 *
 * Global for the same reason `MessagingModule` is: the transport providers that inject these tokens
 * are declared over there, so the bindings have to be visible without that module importing this one
 * — the import would reintroduce exactly the edge this split removes.
 */
@Global()
@Module({
  // Reaches into Order and Payment for their handlers rather than reimplementing their effects.
  // One-way: neither imports this module — both read the outbox port off the global MessagingModule
  // export — so the graph stays acyclic.
  imports: [OrderModule, PaymentModule],
  providers: [
    OrderEventsHandler,
    DomainEventDispatcher,
    { provide: DOMAIN_EVENT_DISPATCHER, useExisting: DomainEventDispatcher },
    { provide: EVENT_LABEL_REGISTRY, useExisting: DomainEventDispatcher },
  ],
  exports: [DOMAIN_EVENT_DISPATCHER, EVENT_LABEL_REGISTRY, DomainEventDispatcher],
})
export class CommerceMessagingModule {}
