import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import {
  LOCK_BUDGET_EXHAUSTED,
  type ReservationCommand,
  commandOutcomeOf,
  isLockBudgetExhausted,
  reservationRoutes,
  statusesOf,
  tryOutcomeOf,
} from '@jcool/internal-contracts';
import { correlationHeaders } from '@jcool/platform/observability';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';
import type { ParticipantTryOutcome } from '../domain/checkout-saga';
import type {
  OrderInventoryParticipantPort,
  StockCommandOutcome,
  StockHoldStatus,
  StockTryInput,
} from '../application/ports/order-inventory-participant.port';

export const INVENTORY_SERVICE_BREAKER = 'inventory-service';

// Above the adapter's own deadlines, so a slow call ends on its abort signal rather than the breaker.
const BREAKER_HEADROOM_MS = 1_000;

export interface InventoryServiceOptions {
  url: string;
  token: string;
  tryTimeoutMs: number;
  commandTimeoutMs: number;
}

type CallOptions = Parameters<OrderInventoryParticipantPort['commit']>[1];

/** The inventory-service answered, but not with an outcome the contract names. */
export class InventoryServiceRejection extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code?: string,
  ) {
    super(`inventory-service ${path} answered ${status}${code ? ` ${code}` : ''} with no outcome the contract names`);
    this.name = 'InventoryServiceRejection';
  }
}

// A body that is not JSON is still an answer; a read cut off by the deadline or the caller is not.
function unparsedAsNull(error: unknown): null {
  if (error instanceof SyntaxError) return null;
  throw error;
}

/**
 * Only a 5xx or no answer at all says the service is unwell; a 409, a 429 or another 4xx is an answer.
 * So is a 503 for busy rows, or one hot SKU would open the circuit for every other.
 */
export function isInventoryServiceFault(error: unknown): boolean {
  if (!(error instanceof InventoryServiceRejection)) return true;
  return error.status >= 500 && error.code !== LOCK_BUDGET_EXHAUSTED;
}

/**
 * Stock over the inventory-service's internal API. Anything but a contract outcome is thrown and the
 * activity's retry policy is the retry, which is safe because every route is idempotent per order.
 */
export class OrderInventoryParticipantHttpAdapter implements OrderInventoryParticipantPort {
  constructor(
    private readonly options: InventoryServiceOptions,
    private readonly breaker: OutboundCall,
    private readonly cls: ClsService,
  ) {}

  tryReserve(
    { orderId, lines, holdUntil }: StockTryInput,
    { signal }: CallOptions = {},
  ): Promise<ParticipantTryOutcome> {
    const body = {
      lines: lines.map(({ skuId, quantity }) => ({ variantId: skuId, quantity })),
      holdUntil: holdUntil.toISOString(),
    };
    return this.post(reservationRoutes.try(orderId), body, this.options.tryTimeoutMs, signal, tryOutcomeOf);
  }

  commit(orderId: string, options?: CallOptions): Promise<StockCommandOutcome> {
    return this.command(orderId, 'commit', options);
  }

  release(orderId: string, options?: CallOptions): Promise<StockCommandOutcome> {
    return this.command(orderId, 'release', options);
  }

  restock(orderId: string, options?: CallOptions): Promise<StockCommandOutcome> {
    return this.command(orderId, 'restock', options);
  }

  statusOf(orderIds: string[], { signal }: CallOptions = {}): Promise<Map<string, StockHoldStatus | null>> {
    if (orderIds.length === 0) return Promise.resolve(new Map<string, StockHoldStatus | null>());
    return this.post(reservationRoutes.status, { orderIds }, this.options.commandTimeoutMs, signal, (status, body) =>
      status === 200 ? statusesOf(body, orderIds) : undefined,
    );
  }

  private command(
    orderId: string,
    command: ReservationCommand,
    { signal }: CallOptions = {},
  ): Promise<StockCommandOutcome> {
    const path = reservationRoutes.command(orderId, command);
    return this.post(path, undefined, this.options.commandTimeoutMs, signal, commandOutcomeOf);
  }

  private post<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    read: (status: number, body: unknown) => T | undefined,
  ): Promise<T> {
    return this.breaker.run(async () => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetch(new URL(path, this.options.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          ...correlationHeaders(this.cls),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
      const parsed: unknown = await response.json().catch(unparsedAsNull);
      const answer = read(response.status, parsed);
      if (answer !== undefined) return answer;
      const code = isLockBudgetExhausted(response.status, parsed) ? LOCK_BUDGET_EXHAUSTED : undefined;
      throw new InventoryServiceRejection(response.status, path, code);
    });
  }
}

/** One breaker for every route: what it tracks is the service's health, not one endpoint's. */
export function createInventoryServiceAdapter(
  config: ConfigService,
  breakers: CircuitBreakerFactory,
  cls: ClsService,
): OrderInventoryParticipantHttpAdapter {
  const tryTimeoutMs = config.getOrThrow<number>('checkoutSaga.tryTimeoutMs');
  const commandTimeoutMs = config.getOrThrow<number>('inventoryService.commandTimeoutMs');
  return new OrderInventoryParticipantHttpAdapter(
    {
      url: config.getOrThrow<string>('inventoryService.url'),
      token: config.getOrThrow<string>('inventoryService.token'),
      tryTimeoutMs,
      commandTimeoutMs,
    },
    breakers.create(INVENTORY_SERVICE_BREAKER, {
      timeoutMs: Math.max(tryTimeoutMs, commandTimeoutMs) + BREAKER_HEADROOM_MS,
      isDownstreamFault: isInventoryServiceFault,
    }),
    cls,
  );
}
