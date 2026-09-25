import { vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { ProductChangedHandler } from '@modules/catalog/interface/queue/product-changed.handler';
import type { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import type { PaymentEventsHandler } from '@modules/order/interface/queue/payment-events.handler';
import type { OrderCancelledHandler } from '@modules/payment/interface/queue/order-cancelled.handler';
import type { OrderExpiredHandler } from '@modules/payment/interface/queue/order-expired.handler';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import { OrderEventsHandler } from '../handlers/order-events.handler';

export interface DispatcherHandlerDoubles {
  orderEvents?: OrderEventsHandler;
  settle?: PaymentEventsHandler['settle'];
  closeExpired?: OrderExpiredHandler['close'];
  closeCancelled?: OrderCancelledHandler['close'];
  prepareMail?: OrderPaidMailHandler['prepare'];
  applyProductChanged?: ProductChangedHandler['apply'];
}

/**
 * The real dispatch table over handler doubles. Specs that assert on `label()` need the actual
 * registry, not a stub that folds names by the same rule the assertion expects.
 */
export function dispatcherWith(doubles: DispatcherHandlerDoubles = {}): DomainEventDispatcher {
  return new DomainEventDispatcher(
    doubles.orderEvents ?? new OrderEventsHandler(fakePinoLogger()),
    { settle: doubles.settle ?? vi.fn() } as unknown as PaymentEventsHandler,
    { close: doubles.closeExpired ?? vi.fn() } as unknown as OrderExpiredHandler,
    { close: doubles.closeCancelled ?? vi.fn() } as unknown as OrderCancelledHandler,
    { prepare: doubles.prepareMail ?? vi.fn() } as unknown as OrderPaidMailHandler,
    { apply: doubles.applyProductChanged ?? vi.fn() } as unknown as ProductChangedHandler,
  );
}
