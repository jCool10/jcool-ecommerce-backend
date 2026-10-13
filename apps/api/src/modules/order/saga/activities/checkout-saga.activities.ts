import { HttpStatus } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import type { MetricsPort, SagaStep } from '@jcool/metrics-port';
import type { CompensationCause, OrderChange, TryVerdict } from '../../domain/checkout-saga';
import type { Compensation } from '../../domain/checkout-saga-step';
import type { OrderStatus } from '../../domain/order-status';
import { toView } from '../../application/order-view.mapper';
import type { IdempotencyStorePort } from '../../application/ports/idempotency-store.port';
import type { InventoryTccPort, ReserveLine, ReserveOutcome } from '../../application/ports/inventory-participant.port';
import type { OrderRepositoryPort } from '../../application/ports/order-repository.port';
import type { PaymentTccPort } from '../../application/ports/payment-participant.port';
import {
  SagaOrderMissingError,
  type CheckoutOrderWriter,
  type OrderWrite,
} from '../../application/saga/checkout-order.writer';

// Failure messages land in workflow history, which is not encrypted: name and message only.
const MAX_FAILURE_MESSAGE = 500;

export interface CheckoutSagaActivityDeps {
  inventory: InventoryTccPort;
  payment: PaymentTccPort;
  writer: CheckoutOrderWriter;
  orders: OrderRepositoryPort;
  idempotencyStore: IdempotencyStorePort;
  metrics: MetricsPort;
  logger: PinoLogger;
}

/** `applied` covers a retry whose earlier attempt already committed the same change. */
export type OrderWriteResult = 'applied' | 'stale';

export interface OrderChangeInput {
  orderId: string;
  from: OrderStatus;
  change: OrderChange;
  cause: CompensationCause | null;
}

type CompensationOutcome =
  | Awaited<ReturnType<InventoryTccPort['release']>>
  | Awaited<ReturnType<InventoryTccPort['restock']>>
  | Awaited<ReturnType<PaymentTccPort['cancel']>>;

/** A record, not a set, so a new participant outcome fails the build until it is classified here. */
const SETTLES: Record<CompensationOutcome, boolean> = {
  RELEASED: true,
  RESTOCKED: true,
  CANCELLED: true,
  FENCED: true,
  CONFLICT: false,
  CAPTURED_CONFLICT: false,
};

export function createCheckoutSagaActivities(deps: CheckoutSagaActivityDeps) {
  const { inventory, payment, writer, orders, idempotencyStore, metrics, logger } = deps;

  async function writeOrder(
    { orderId, from, change, cause }: OrderChangeInput,
    inTx?: OrderWrite['inTx'],
    onWritten?: () => void,
  ): Promise<OrderWriteResult> {
    let outcome;
    try {
      outcome = await writer.apply({ orderId, from, change, inTx });
    } catch (error) {
      if (error instanceof SagaOrderMissingError) {
        throw ApplicationFailure.nonRetryable(error.message, error.name);
      }
      throw toFailure(error);
    }
    if (outcome === 'written') {
      if (cause !== null) metrics.recordCompensation(cause);
      onWritten?.();
    }
    return outcome === 'stale' ? 'stale' : 'applied';
  }

  async function step<T>(name: SagaStep, call: () => Promise<T>, succeeded: (answer: T) => boolean): Promise<T> {
    let answer: T;
    try {
      answer = await call();
    } catch (error) {
      metrics.recordSagaStep(name, 'failed');
      throw toFailure(error);
    }
    metrics.recordSagaStep(name, succeeded(answer) ? 'success' : 'failed');
    return answer;
  }

  async function compensate(
    compensation: Compensation,
    orderId: string,
    call: () => Promise<CompensationOutcome>,
  ): Promise<void> {
    const outcome = await step('compensate', call, (answer) => SETTLES[answer]);
    if (!SETTLES[outcome]) {
      logger.error(
        { orderId, compensation, outcome },
        'compensation conflicts with participant state and will keep retrying until resolved by hand',
      );
      throw ApplicationFailure.retryable(`${compensation} conflicts with participant state: ${outcome}`, outcome);
    }
  }

  return {
    async tryReserve(input: { orderId: string; lines: ReserveLine[]; holdUntil: string }): Promise<ReserveOutcome> {
      try {
        return await inventory.tryReserve({ ...input, holdUntil: new Date(input.holdUntil) });
      } catch (error) {
        throw toFailure(error);
      }
    },

    async applyTryResult(
      input: OrderChangeInput & { verdict: TryVerdict; idempotency?: { scope: string; key: string } },
    ): Promise<OrderWriteResult> {
      const { orderId, verdict, idempotency } = input;
      const completeKey: OrderWrite['inTx'] =
        verdict === 'HELD' && idempotency
          ? (tx, order) =>
              idempotencyStore.markCompleted(
                { ...idempotency, responseStatus: HttpStatus.CREATED, responseBody: toView(order), orderId },
                tx,
              )
          : undefined;
      return writeOrder(input, completeKey, () =>
        metrics.recordSagaStep('try_reserve', verdict === 'HELD' ? 'success' : 'failed'),
      );
    },

    applyOrderChange(input: OrderChangeInput): Promise<OrderWriteResult> {
      return writeOrder(input);
    },

    commitStock(orderId: string): Promise<'COMMITTED' | 'CONFLICT'> {
      return step(
        'commit_stock',
        () => inventory.commit(orderId),
        (outcome) => outcome === 'COMMITTED',
      );
    },

    capturePayment(orderId: string): Promise<'CAPTURED' | 'NOT_CAPTURABLE'> {
      return step(
        'capture',
        () => payment.capture(orderId),
        (outcome) => outcome === 'CAPTURED',
      );
    },

    releaseStock(orderId: string): Promise<void> {
      return compensate('RELEASE_STOCK', orderId, () => inventory.release(orderId));
    },

    restock(orderId: string): Promise<void> {
      return compensate('RESTOCK', orderId, () => inventory.restock(orderId));
    },

    cancelPayment(orderId: string): Promise<void> {
      return compensate('CANCEL_PAYMENT', orderId, () => payment.cancel(orderId));
    },

    recordCompensation(cause: CompensationCause): Promise<void> {
      metrics.recordCompensation(cause);
      return Promise.resolve();
    },

    async loadLateAuthorizationContext(orderId: string): Promise<{ status: OrderStatus | null }> {
      const order = await orders.findById(orderId);
      return { status: order?.status ?? null };
    },
  };
}

export type CheckoutSagaActivities = ReturnType<typeof createCheckoutSagaActivities>;

function toFailure(error: unknown): ApplicationFailure {
  if (error instanceof ApplicationFailure) return error;
  const { name, message } = toError(error);
  return ApplicationFailure.retryable(`${name}: ${message}`.slice(0, MAX_FAILURE_MESSAGE), name);
}
