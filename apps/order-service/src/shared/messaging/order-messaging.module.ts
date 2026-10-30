import type { DynamicModule } from '@nestjs/common';
import { MessagingModule } from '@jcool/messaging';
import { OrderModule } from '../../modules/order/order.module';
import { ID_GENERATOR } from '../identity/id-generator.port';
import { OrderEventsAudit, OrderEventsDispatcher } from './order-events.handlers';
import { ORDER_CONSUMED_QUEUES, ORDER_EVENT_ROUTES } from './order-events.routes';

export const OrderMessagingModule: DynamicModule = MessagingModule.forRoot({
  routes: ORDER_EVENT_ROUTES,
  queues: ORDER_CONSUMED_QUEUES.map((queue) => ({ ...queue, dispatcher: OrderEventsDispatcher })),
  idGenerator: ID_GENERATOR,
  // One-way: OrderModule reads the outbox port off the global export and never imports this module.
  imports: [OrderModule],
  providers: [OrderEventsAudit, OrderEventsDispatcher],
});
