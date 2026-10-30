import { vi } from 'vitest';
import type { CategoryRenamedHandler } from '@modules/product/interface/catalog/queue/category-renamed.handler';
import type { ProductChangedHandler } from '@modules/product/interface/catalog/queue/product-changed.handler';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';

export interface DispatcherHandlerDoubles {
  applyProductChanged?: ProductChangedHandler['apply'];
  applyCategoryRenamed?: CategoryRenamedHandler['apply'];
}

/**
 * The real dispatch table over handler doubles. Specs that assert on `handles()` need the actual
 * registry, not a stub that folds names by the same rule the assertion expects.
 */
export function dispatcherWith(doubles: DispatcherHandlerDoubles = {}): DomainEventDispatcher {
  return new DomainEventDispatcher(
    { apply: doubles.applyProductChanged ?? vi.fn() } as unknown as ProductChangedHandler,
    { apply: doubles.applyCategoryRenamed ?? vi.fn() } as unknown as CategoryRenamedHandler,
  );
}
