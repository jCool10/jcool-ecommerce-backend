import type { DynamicModule } from '@nestjs/common';
import { MessagingModule } from '@jcool/messaging';
import { ProductModule } from '@modules/product/product.module';
import { ID_GENERATOR } from '@shared/identity/id-generator.port';
import { API_CONSUMED_QUEUES, API_EVENT_ROUTES } from './event-routes';
import { DomainEventDispatcher } from './handlers/domain-event.dispatcher';

export const ApiMessagingModule: DynamicModule = MessagingModule.forRoot({
  routes: API_EVENT_ROUTES,
  queues: API_CONSUMED_QUEUES.map((queue) => ({ ...queue, dispatcher: DomainEventDispatcher })),
  idGenerator: ID_GENERATOR,
  // Reaches into Product for its handlers rather than reimplementing their effects. One-way: Product
  // reads the outbox port off the global export, so the graph stays acyclic.
  imports: [ProductModule],
  providers: [DomainEventDispatcher],
});
