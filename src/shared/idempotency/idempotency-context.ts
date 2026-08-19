import type { ClsService } from 'nestjs-cls';

/** CLS key holding the idempotency scope+key for the active request. */
export const IDEMPOTENCY_CLS_KEY = 'idempotency';

export interface IdempotencyContext {
  scope: string;
  key: string;
}

/**
 * Carries {scope, key} from the interceptor down to the use case over the already-mounted CLS
 * request context, so the checkout transaction can flip the idempotency record to COMPLETED
 * inside the same unit of work as the order + reservation. Reuses the correlation CLS store —
 * no separate AsyncLocalStorage.
 */
export function setIdempotencyContext(cls: ClsService, ctx: IdempotencyContext): void {
  cls.set(IDEMPOTENCY_CLS_KEY, ctx);
}

export function getIdempotencyContext(cls: ClsService): IdempotencyContext | undefined {
  return cls.isActive() ? cls.get<IdempotencyContext>(IDEMPOTENCY_CLS_KEY) : undefined;
}
