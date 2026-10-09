import { vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import type { PaymentAuthorizedHandler } from '@modules/order/interface/queue/payment-authorized.handler';
import type { CategoryRenamedHandler } from '@modules/product/interface/catalog/queue/category-renamed.handler';
import type { ProductChangedHandler } from '@modules/product/interface/catalog/queue/product-changed.handler';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import { OrderEventsHandler } from '../handlers/order-events.handler';

export interface DispatcherHandlerDoubles {
  orderEvents?: OrderEventsHandler;
  prepareAuthorized?: PaymentAuthorizedHandler['prepare'];
  prepareMail?: OrderPaidMailHandler['prepare'];
  applyProductChanged?: ProductChangedHandler['apply'];
  applyCategoryRenamed?: CategoryRenamedHandler['apply'];
}

/**
 * The real dispatch table over handler doubles. Specs that assert on `label()` need the actual
 * registry, not a stub that folds names by the same rule the assertion expects.
 */
export function dispatcherWith(doubles: DispatcherHandlerDoubles = {}): DomainEventDispatcher {
  return new DomainEventDispatcher(
    doubles.orderEvents ?? new OrderEventsHandler(fakePinoLogger()),
    { prepare: doubles.prepareAuthorized ?? vi.fn() } as unknown as PaymentAuthorizedHandler,
    { prepare: doubles.prepareMail ?? vi.fn() } as unknown as OrderPaidMailHandler,
    { apply: doubles.applyProductChanged ?? vi.fn() } as unknown as ProductChangedHandler,
    { apply: doubles.applyCategoryRenamed ?? vi.fn() } as unknown as CategoryRenamedHandler,
  );
}
