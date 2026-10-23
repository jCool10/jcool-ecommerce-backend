import type { INestApplication } from '@nestjs/common';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  CHECKOUT_SAGA_ENGINE,
  type CheckoutSagaEnginePort,
  type CheckoutSagaStart,
} from '../../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../../src/modules/order/application/ports/order-repository.port';
import type { CheckoutSagaMode, PaymentAuthorization } from '../../../src/modules/order/domain/checkout-saga';
import type { Order } from '../../../src/modules/order/domain/order.entity';
import { checkoutWorkflowId } from '../../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { CheckoutSagaWorker } from '../../../src/modules/order/infrastructure/temporal/checkout-saga.worker';
import { TEMPORAL_CLIENT } from '../../../src/modules/order/infrastructure/temporal/temporal.providers';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';
import { sleep } from '../sleep';

const POLL_MS = 20;
const HELD_WAIT_TIMEOUT_MS = 5_000;
const IDLE_WAIT_TIMEOUT_MS = 10_000;

export const sagaEngine = (app: INestApplication): CheckoutSagaEnginePort =>
  app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE, { strict: false });

export const sagaWorker = (app: INestApplication): CheckoutSagaWorker => app.get(CheckoutSagaWorker, { strict: false });

export function checkoutSagaStartOf(order: Order, mode: CheckoutSagaMode = 'checkout'): CheckoutSagaStart {
  if (!order.id || !order.placedAt || !order.paymentDeadlineAt) {
    throw new Error(`order ${order.id ?? '(unsaved)'} was not placed through the saga`);
  }
  return {
    mode,
    orderId: order.id,
    userId: order.userId,
    lines: order.items.map(({ skuId, quantity }) => ({ skuId, quantity })),
    totalMinor: order.totalAmountMinor,
    currency: order.currency,
    placedAt: order.placedAt,
    deadlineAt: order.paymentDeadlineAt,
  };
}

// Every call parked by any holdCalls, so a reset can end them whichever test left them behind.
const parked = new Set<(error: Error) => void>();
const restorers = new Set<() => void>();

export interface HeldCalls {
  /** Calls that reached the method since the hold began, parked or let through. */
  readonly count: number;
  waitForCalls(count: number): Promise<void>;
  /** Runs the parked calls for real, lets later ones straight through and puts the method back. */
  release(): void;
}

type AsyncMethodKey<T> = { [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never }[keyof T];

/**
 * Parks every call to `port[method]` until `release()`. Patches the instance, which the saga
 * activities read at call time. A parked call ignores its abort signal on purpose: it stands for a
 * participant that cannot be interrupted.
 */
export function holdCalls<T extends object>(port: T, method: AsyncMethodKey<T>): HeldCalls {
  const target = port as Record<PropertyKey, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(port, method);
  const original = target[method] as (...args: unknown[]) => Promise<unknown>;
  const waiting: (() => void)[] = [];
  let released = false;
  let count = 0;

  const restore = () => {
    restorers.delete(restore);
    if (hadOwn) target[method] = original;
    else delete target[method];
  };
  restorers.add(restore);

  target[method] = (...args: unknown[]): Promise<unknown> => {
    count += 1;
    if (released) return original.apply(port, args);
    return new Promise((resolve, reject) => {
      const abort = (error: Error) => reject(error);
      parked.add(abort);
      waiting.push(() => {
        parked.delete(abort);
        resolve(original.apply(port, args));
      });
    });
  };

  return {
    get count() {
      return count;
    },
    async waitForCalls(expected: number) {
      const deadline = Date.now() + HELD_WAIT_TIMEOUT_MS;
      while (count < expected) {
        if (Date.now() > deadline) throw new Error(`expected ${expected} held calls, saw ${count}`);
        await sleep(POLL_MS);
      }
    },
    release() {
      released = true;
      restore();
      for (const run of waiting.splice(0)) run();
    },
  };
}

/** Fails every parked call with an AbortError, so a hung activity ends, and undoes every hold. */
export function releaseHung(): void {
  for (const abort of [...parked]) {
    parked.delete(abort);
    const error = new Error('held call aborted by the test');
    error.name = 'AbortError';
    abort(error);
  }
  for (const restore of [...restorers]) restore();
}

/**
 * Stands in for the payment.authorized consumer: forwards the outbox row straight to the engine,
 * with the late-authorization start it would build.
 */
export async function relayAuthorizationDirect(app: INestApplication, orderId: string): Promise<PaymentAuthorization> {
  const rows = await app
    .get<DrizzleDB>(DRIZZLE)
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.eventType, 'payment.authorized'), sql`${schema.outbox.payload}->>'orderId' = ${orderId}`),
    );
  if (rows.length !== 1) throw new Error(`expected one payment.authorized row for ${orderId}, found ${rows.length}`);

  const { paymentId, amountMinor, currency, authorizedAt } = rows[0].payload as unknown as PaymentAuthorization;
  const authorization = { paymentId, amountMinor, currency, authorizedAt };
  const order = await app.get<OrderRepositoryPort>(ORDER_REPOSITORY, { strict: false }).findById(orderId);
  if (!order) throw new Error(`order ${orderId} not found`);

  await sagaEngine(app).notifyAuthorized(checkoutSagaStartOf(order, 'lateAuthorization'), authorization);
  return authorization;
}

/**
 * Run before the TRUNCATE: it finds the runs through the orders table. Terminates by id rather than
 * through visibility, which lags, then waits for every app's worker to have nothing in flight so no
 * activity from this test writes into the next one.
 */
export async function resetCheckoutSagas(apps: INestApplication[]): Promise<void> {
  const [first] = apps;
  if (!first) return;
  const client = first.get<Client>(TEMPORAL_CLIENT, { strict: false });
  const { rows } = await first.get<Pool>(PG_POOL).query<{ id: string }>('SELECT id FROM orders');
  const orderIds = rows.map(({ id }) => id);

  await Promise.all(orderIds.map((orderId) => terminate(client, checkoutWorkflowId(orderId))));
  releaseHung();

  const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
  while (apps.some((app) => inFlight(app) > 0)) {
    if (Date.now() > deadline) {
      throw new Error(
        `saga activities still in flight ${IDLE_WAIT_TIMEOUT_MS}ms after reset; orders: ${orderIds.join(', ')}`,
      );
    }
    await sleep(POLL_MS);
  }
}

async function terminate(client: Client, workflowId: string): Promise<void> {
  try {
    await client.workflow.getHandle(workflowId).terminate('test reset');
  } catch (error: unknown) {
    // Never started, or already closed.
    if (!(error instanceof WorkflowNotFoundError)) throw error;
  }
}

function inFlight(app: INestApplication): number {
  const { inFlightActivities, inFlightLocalActivities } = sagaWorker(app).status();
  return inFlightActivities + inFlightLocalActivities;
}
