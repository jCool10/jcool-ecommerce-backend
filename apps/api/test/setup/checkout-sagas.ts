import type { INestApplication } from '@nestjs/common';
import {
  Client,
  Connection,
  WorkflowNotFoundError,
  type WorkflowExecutionDescription,
  type WorkflowHandle,
} from '@temporalio/client';
import type { Pool } from 'pg';
import { inject } from 'vitest';
import type { CheckoutSagaStep } from '../../src/modules/order/domain/checkout-saga-step';
import { TEMPORAL_CLIENT } from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import {
  CHECKOUT_STEP_ATTRIBUTE,
  stateQuery,
  workflowIdFor,
  type CheckoutSagaState,
} from '../../src/modules/order/saga/checkout-saga.contract';
import { sleep } from './sleep';
import { TEMPORAL_E2E_NAMESPACE } from './temporal-server';

const POLL_MS = 100;
const DEFAULT_WAIT_MS = 15_000;

export function sagaHandle(app: INestApplication, orderId: string): WorkflowHandle {
  return app.get<Client>(TEMPORAL_CLIENT).workflow.getHandle(workflowIdFor(orderId));
}

export function readSagaState(app: INestApplication, orderId: string): Promise<CheckoutSagaState> {
  return sagaHandle(app, orderId).query(stateQuery);
}

/** The latest run, or null when no saga was ever started for the order. */
export async function describeSaga(
  app: INestApplication,
  orderId: string,
): Promise<WorkflowExecutionDescription | null> {
  try {
    return await sagaHandle(app, orderId).describe();
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
}

/** Read from the search attribute, so it also answers for a closed run. */
export async function sagaStepAttribute(app: INestApplication, orderId: string): Promise<CheckoutSagaStep | null> {
  const description = await describeSaga(app, orderId);
  return (description?.typedSearchAttributes.get(CHECKOUT_STEP_ATTRIBUTE) as CheckoutSagaStep | undefined) ?? null;
}

export async function waitForSagaState(
  app: INestApplication,
  orderId: string,
  matches: (state: CheckoutSagaState) => boolean,
  { timeoutMs = DEFAULT_WAIT_MS }: { timeoutMs?: number } = {},
): Promise<CheckoutSagaState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readSagaState(app, orderId);
    if (matches(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`saga ${orderId} never reached the expected state; last ${JSON.stringify(state)}`);
    }
    await sleep(POLL_MS);
  }
}

export function waitForSagaStep(
  app: INestApplication,
  orderId: string,
  step: CheckoutSagaStep,
  options?: { timeoutMs?: number },
): Promise<CheckoutSagaState> {
  return waitForSagaState(app, orderId, (state) => state.step === step, options);
}

export async function waitForSagaClosed(
  app: INestApplication,
  orderId: string,
  { timeoutMs = DEFAULT_WAIT_MS }: { timeoutMs?: number } = {},
): Promise<WorkflowExecutionDescription> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const description = await describeSaga(app, orderId);
    if (!description) throw new Error(`no saga was started for order ${orderId}`);
    if (description.status.name !== 'RUNNING') return description;
    if (Date.now() > deadline) {
      const state = await readSagaState(app, orderId).catch(() => 'unavailable');
      throw new Error(`saga ${orderId} still running after ${timeoutMs}ms; state ${JSON.stringify(state)}`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * A saga left running by one test would keep acting on the next test's rows once its timer fires,
 * so every order's workflow is terminated before the truncate. Ids come from the orders table rather
 * than a visibility query, which lags behind a just-started workflow.
 */
export async function terminateCheckoutSagas(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM orders');
  if (rows.length === 0) return;

  const connection = await Connection.connect({ address: inject('TEMPORAL_ADDRESS') });
  try {
    const client = new Client({ connection, namespace: TEMPORAL_E2E_NAMESPACE });
    await Promise.all(
      rows.map(({ id }) =>
        client.workflow
          .getHandle(workflowIdFor(id))
          .terminate('e2e reset')
          .catch((error: unknown) => {
            // Never started, or already closed.
            if (!(error instanceof WorkflowNotFoundError)) throw error;
          }),
      ),
    );
  } finally {
    await connection.close();
  }
}
