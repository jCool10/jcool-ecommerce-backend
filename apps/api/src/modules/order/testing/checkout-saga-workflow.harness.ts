import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from '@temporalio/worker';
import { OrderStatus } from '../domain/order-status';
import type { CheckoutSagaActivities } from '../saga/activities/checkout-saga.activities';
import {
  CHECKOUT_DEADLINE_ATTRIBUTE,
  CHECKOUT_SAGA_WORKFLOW,
  CHECKOUT_STEP_ATTRIBUTE,
  reserveUpdate,
  RESERVE_UPDATE_ID,
  stateQuery,
  workflowIdFor,
  type CheckoutSagaInput,
  type CheckoutSagaStart,
  type CheckoutSagaState,
  type CheckoutSagaTimings,
} from '../saga/checkout-saga.contract';
import type { CheckoutSaga } from '../saga/workflows/checkout-saga.workflow';

export const WORKFLOWS_PATH = resolve(__dirname, '../saga/workflows');

export const TEST_TIMINGS: CheckoutSagaTimings = {
  tryTimeoutMs: 2_000,
  authGraceMs: 180_000,
  cancelWaitMs: 5_000,
  activityTimeoutMs: 10_000,
  retryBaseMs: 100,
  retryCapMs: 1_000,
};

export const ORDER_TOTAL = { totalMinor: 240_000, currency: 'VND' };
const PAYMENT_DEADLINE_MS = 3_600_000;

export type CheckoutSagaHandle = WorkflowHandle<typeof CheckoutSaga>;

export interface SagaTestBed {
  env: TestWorkflowEnvironment;
  workflowBundle: WorkflowBundle;
}

// temporal.api.enums.v1.IndexedValueType; @temporalio/proto is not a direct dependency.
const INDEXED_VALUE_TYPE_KEYWORD = 2;
const INDEXED_VALUE_TYPE_DATETIME = 6;

// The default is pid@hostname, which would end up in the committed replay histories.
const TEST_IDENTITY = 'checkout-saga-test';

const quiet = new DefaultLogger('WARN');

function installQuietRuntime(): void {
  try {
    Runtime.install({ logger: quiet, shutdownSignals: [] });
  } catch {
    // Another spec in this process installed it first.
  }
}

export async function createSagaTestBed(): Promise<SagaTestBed> {
  installQuietRuntime();
  const [env, workflowBundle] = await Promise.all([
    TestWorkflowEnvironment.createTimeSkipping({ client: { identity: TEST_IDENTITY } }),
    bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet }),
  ]);
  await env.connection.operatorService.addSearchAttributes({
    namespace: env.namespace ?? 'default',
    searchAttributes: {
      [CHECKOUT_STEP_ATTRIBUTE.name]: INDEXED_VALUE_TYPE_KEYWORD,
      [CHECKOUT_DEADLINE_ATTRIBUTE.name]: INDEXED_VALUE_TYPE_DATETIME,
    },
  });
  return { env, workflowBundle };
}

export interface RecordedCall {
  name: keyof CheckoutSagaActivities;
  args: unknown[];
}

/** Every activity answers the happy path unless overridden; each call is recorded in order. */
export function recordingActivities(overrides: Partial<CheckoutSagaActivities> = {}) {
  const defaults: CheckoutSagaActivities = {
    tryReserve: () => Promise.resolve('HELD'),
    applyTryResult: () => Promise.resolve('applied'),
    applyOrderChange: () => Promise.resolve('applied'),
    commitStock: () => Promise.resolve('COMMITTED'),
    capturePayment: () => Promise.resolve('CAPTURED'),
    releaseStock: () => Promise.resolve(),
    restock: () => Promise.resolve(),
    cancelPayment: () => Promise.resolve(),
    recordCompensation: () => Promise.resolve(),
    loadLateAuthorizationContext: () => Promise.resolve({ status: OrderStatus.PENDING }),
  };
  const calls: RecordedCall[] = [];
  const activities = Object.fromEntries(
    Object.entries({ ...defaults, ...overrides }).map(([name, run]) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name: name as keyof CheckoutSagaActivities, args });
        return (run as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as CheckoutSagaActivities;
  const callsTo = (name: keyof CheckoutSagaActivities): unknown[][] =>
    calls.filter((call) => call.name === name).map((call) => call.args);
  return { activities, calls, callsTo };
}

/** Runs `body` against a worker of its own, so a test never picks up another test's tasks. */
export async function withWorker<T>(
  { env, workflowBundle }: SagaTestBed,
  activities: CheckoutSagaActivities,
  body: (taskQueue: string) => Promise<T>,
): Promise<T> {
  const taskQueue = `checkout-saga-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    taskQueue,
    identity: TEST_IDENTITY,
    workflowBundle,
    activities,
  });
  return worker.runUntil(body(taskQueue));
}

export async function checkoutStart(
  env: TestWorkflowEnvironment,
  overrides: Partial<CheckoutSagaStart> = {},
): Promise<CheckoutSagaStart> {
  const now = await env.currentTimeMs();
  const deadline = now + PAYMENT_DEADLINE_MS;
  return {
    mode: 'checkout',
    orderId: randomUUID(),
    lines: [{ skuId: 'sku-1', quantity: 2 }],
    ...ORDER_TOTAL,
    placedAt: new Date(now).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    holdUntil: new Date(deadline + PAYMENT_DEADLINE_MS).toISOString(),
    idempotency: { scope: 'user:u1', key: randomUUID() },
    timings: TEST_TIMINGS,
    ...overrides,
  };
}

export function startSaga(env: TestWorkflowEnvironment, taskQueue: string, input: CheckoutSagaInput) {
  return env.client.workflow.start<typeof CheckoutSaga>(CHECKOUT_SAGA_WORKFLOW, {
    workflowId: workflowIdFor(input.orderId),
    taskQueue,
    args: [input],
  });
}

export async function reserve(handle: CheckoutSagaHandle): Promise<string> {
  const { verdict } = await handle.executeUpdate(reserveUpdate, { updateId: RESERVE_UPDATE_ID });
  return verdict;
}

export function sagaState(handle: CheckoutSagaHandle): Promise<CheckoutSagaState> {
  return handle.query(stateQuery);
}

export async function stepAttribute(handle: CheckoutSagaHandle): Promise<string | undefined> {
  const { typedSearchAttributes } = await handle.describe();
  return typedSearchAttributes.get(CHECKOUT_STEP_ATTRIBUTE);
}

/** Polls in real time: the state a signal or timer leads to lands on the worker's next task. */
export async function waitForState(
  handle: CheckoutSagaHandle,
  matches: (state: CheckoutSagaState) => boolean,
  timeoutMs = 10_000,
): Promise<CheckoutSagaState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await sagaState(handle);
    if (matches(state)) return state;
    if (Date.now() > deadline) throw new Error(`saga never reached the expected state; last: ${JSON.stringify(state)}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

export function deferred<T>() {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}
