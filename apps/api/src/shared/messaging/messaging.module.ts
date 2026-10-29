import type { DynamicModule } from '@nestjs/common';
import { MessagingModule } from '@jcool/messaging';
import { OrderModule } from '@modules/order/order.module';
import { ProductModule } from '@modules/product/product.module';
import { ID_GENERATOR } from '@shared/identity/id-generator.port';
import { API_CONSUMED_QUEUES, API_EVENT_ROUTES } from './event-routes';
import { DomainEventDispatcher } from './handlers/domain-event.dispatcher';
import { OrderEventsHandler } from './handlers/order-events.handler';

export const ApiMessagingModule: DynamicModule = MessagingModule.forRoot({
  routes: API_EVENT_ROUTES,
  queues: API_CONSUMED_QUEUES.map((queue) => ({ ...queue, dispatcher: DomainEventDispatcher })),
  idGenerator: ID_GENERATOR,
  // Reaches into Order and Product for their handlers rather than reimplementing their effects.
  // One-way: neither imports this module — each reads the outbox port off the global export — so the
  // graph stays acyclic.
  imports: [OrderModule, ProductModule],
  providers: [OrderEventsHandler, DomainEventDispatcher],
});
