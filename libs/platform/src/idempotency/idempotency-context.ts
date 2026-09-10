import type { ClsService } from 'nestjs-cls';

export const IDEMPOTENCY_CLS_KEY = 'idempotency';

export interface IdempotencyContext {
  scope: string;
  key: string;
}

/**
 * Rides the already-mounted correlation CLS store (no separate AsyncLocalStorage) so the checkout
 * transaction can flip the idempotency record to COMPLETED in the same unit of work as the order.
 */
export function setIdempotencyContext(cls: ClsService, ctx: IdempotencyContext): void {
  cls.set(IDEMPOTENCY_CLS_KEY, ctx);
}

export function getIdempotencyContext(cls: ClsService): IdempotencyContext | undefined {
  return cls.isActive() ? cls.get<IdempotencyContext>(IDEMPOTENCY_CLS_KEY) : undefined;
}
