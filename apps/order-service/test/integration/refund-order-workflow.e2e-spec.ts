import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry-v2';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  REFUND_CONFLICT_FAILURE,
  REFUND_ORDER_WORKFLOW,
  refundOrderWorkflowId,
  type RefundOrderActivityFunctions,
  type RefundOrderInput,
  type RefundOrderResult,
} from '../../src/modules/order/infrastructure/temporal/refund-order.contract';
import { installTemporalRuntime } from '../../src/modules/order/infrastructure/temporal/temporal-runtime';
import {
  workflowTracingInterceptors,
  workflowTracingSinks,
} from '../../src/modules/order/infrastructure/temporal/workflow-tracing';
import { TEMPORAL_TEST_NAMESPACE } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

// The refund workflow against stub activities on the real dev server, with short settings so the
// pending backoff and the retries take milliseconds. Set CHECKOUT_SAGA_HISTORY_OUT to export the
// histories the replay spec checks.

type Activities = RefundOrderActivityFunctions;
type ActivityName = keyof Activities;
type Script = Partial<Record<ActivityName, (input: never, attempt: number) => Promise<unknown>>>;

const ADMIN_ID = '137465797020397182';
const OTHER_ADMIN_ID = '137465797020397190';
const SETTINGS = {
  activityTimeoutMs: 2_000,
  retryBaseMs: 50,
  retryCapMs: 200,
  pendingPollBaseMs: 100,
  pendingPollMaxMs: 150,
};
const HISTORY_OUT = process.env.CHECKOUT_SAGA_HISTORY_OUT;

const DEFAULTS: Required<Script> = {
  beginRefund: () => Promise.resolve('started'),
  refundPayment: () => Promise.resolve({ outcome: 'REFUNDED' }),
  restockRefundedOrder: () => Promise.resolve('APPLIED'),
  abandonRefund: () => Promise.resolve('applied'),
  completeRefund: () => Promise.resolve('applied'),
};

interface Call {
  name: ActivityName;
  input: Record<string, unknown>;
}

const conflict = () => ApplicationFailure.retryable('participant conflict staged by the test', REFUND_CONFLICT_FAILURE);

describe('RefundOrder workflow (dev server, stub activities)', () => {
  const calls = new Map<string, Call[]>();
  const scripts = new Map<string, Script>();
  const holds: Array<() => void> = [];
  const started: string[] = [];

  let taskQueue: string;
  let nativeConnection: NativeConnection;
  let worker: Worker;
  let running: Promise<void>;
  let connection: Connection;
  let client: Client;

  const stubActivities = (): Activities =>
    Object.fromEntries(
      (Object.keys(DEFAULTS) as ActivityName[]).map((name) => [
        name,
        (input: { orderId: string }) => {
          const log = calls.get(input.orderId) ?? [];
          log.push({ name, input });
          calls.set(input.orderId, log);
          const attempt = log.filter((call) => call.name === name).length;
          const impl = scripts.get(input.orderId)?.[name] ?? DEFAULTS[name];
          return impl(input as never, attempt);
        },
      ]),
    ) as unknown as Activities;

  beforeAll(async () => {
    installTemporalRuntime();
    taskQueue = temporalTaskQueueForCurrentSpec();
    nativeConnection = await NativeConnection.connect({ address: inject('TEMPORAL_ADDRESS') });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: TEMPORAL_TEST_NAMESPACE,
      taskQueue,
      workflowBundle: { codePath: inject('TEMPORAL_WORKFLOW_BUNDLE_PATH') },
      interceptors: workflowTracingInterceptors({ bundling: false }),
      sinks: workflowTracingSinks(),
      activities: stubActivities(),
      maxConcurrentActivityTaskExecutions: 2,
      maxConcurrentLocalActivityExecutions: 2,
      shutdownGraceTime: '500ms',
      shutdownForceTime: '1s',
    });
    running = worker.run();
    connection = await Connection.connect({ address: inject('TEMPORAL_ADDRESS') });
    // Traced like the app's client and worker, so a history recorded here is what production writes.
    client = new Client({
      connection,
      namespace: TEMPORAL_TEST_NAMESPACE,
      interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
    });
  });

  afterEach(async () => {
    holds.splice(0).forEach((release) => release());
    await Promise.all(
      started.splice(0).map((orderId) =>
        handleOf(orderId)
          .terminate('test cleanup')
          .catch(() => undefined),
      ),
    );
  });

  afterAll(async () => {
    worker?.shutdown();
    await running;
    await nativeConnection?.close();
    await connection?.close();
  });

  const refundInput = (requestedBy = ADMIN_ID): RefundOrderInput => ({
    orderId: randomUUID(),
    requestedBy,
    settings: SETTINGS,
  });

  const script = (input: RefundOrderInput, activities: Script): RefundOrderInput => {
    scripts.set(input.orderId, activities);
    return input;
  };

  // The engine's options: an open run is joined, a closed one replaced.
  const start = (input: RefundOrderInput) => {
    started.push(input.orderId);
    return client.workflow.start(REFUND_ORDER_WORKFLOW, {
      workflowId: refundOrderWorkflowId(input.orderId),
      taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      args: [input],
    });
  };

  const handleOf = (orderId: string) => client.workflow.getHandle(refundOrderWorkflowId(orderId));
  const resultOf = (orderId: string): Promise<RefundOrderResult> => handleOf(orderId).result();
  const refund = async (input: RefundOrderInput): Promise<RefundOrderResult> => {
    await start(input);
    return resultOf(input.orderId);
  };

  const namesOf = (orderId: string): ActivityName[] => (calls.get(orderId) ?? []).map((call) => call.name);
  const inputsOf = (orderId: string, name: ActivityName) =>
    (calls.get(orderId) ?? []).filter((call) => call.name === name).map((call) => call.input);

  const hold = <T>(value: T) => {
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (leave = resolve));
    holds.push(leave);
    return {
      started: entered,
      release: leave,
      impl: async (): Promise<T> => {
        enter();
        await released;
        return value;
      },
    };
  };

  const exportHistory = async (orderId: string, name: string): Promise<void> => {
    if (!HISTORY_OUT) return;
    const history = await handleOf(orderId).fetchHistory();
    await mkdir(HISTORY_OUT, { recursive: true });
    // Worker identities and sticky queue names carry the host name; replay needs neither.
    await writeFile(
      join(HISTORY_OUT, `${name}.history.json`),
      historyToJSON(history).replaceAll(hostname(), 'replay-host'),
    );
  };

  const timersOf = async (orderId: string): Promise<number[]> => {
    const { events } = await handleOf(orderId).fetchHistory();
    return (events ?? [])
      .map((event) => event.timerStartedEventAttributes?.startToFireTimeout)
      .filter((timeout) => timeout != null)
      .map((timeout) => Number(timeout.seconds ?? 0) * 1000 + Math.round((timeout.nanos ?? 0) / 1e6));
  };

  it('refunds the money first, then restocks, then completes as the admin who asked', async () => {
    const input = refundInput();

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });

    expect(namesOf(input.orderId)).toEqual(['beginRefund', 'refundPayment', 'restockRefundedOrder', 'completeRefund']);
    expect(inputsOf(input.orderId, 'refundPayment')).toEqual([{ orderId: input.orderId, requestedBy: ADMIN_ID }]);
    expect(inputsOf(input.orderId, 'completeRefund')).toEqual([{ orderId: input.orderId, requestedBy: ADMIN_ID }]);
    await exportHistory(input.orderId, 'refund-completed');
  });

  it('asks again about a refund the provider holds, backing off from base up to max', async () => {
    const input = script(refundInput(), {
      refundPayment: (_input, attempt) =>
        Promise.resolve(attempt <= 2 ? { outcome: 'PENDING' } : { outcome: 'REFUNDED' }),
    });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });

    expect(inputsOf(input.orderId, 'refundPayment')).toHaveLength(3);
    await expect(timersOf(input.orderId)).resolves.toEqual([100, 150]);
    expect(namesOf(input.orderId).slice(-2)).toEqual(['restockRefundedOrder', 'completeRefund']);
    await exportHistory(input.orderId, 'refund-pending-then-completed');
  });

  it('carries on when a retry finds the refund already done', async () => {
    const input = script(refundInput(), { refundPayment: () => Promise.resolve({ outcome: 'IDEMPOTENT' }) });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });
    expect(namesOf(input.orderId)).toContain('restockRefundedOrder');
  });

  it('puts the order back to PAID and leaves the stock alone when the provider fails the refund', async () => {
    const input = script(refundInput(), {
      refundPayment: () => Promise.resolve({ outcome: 'REFUND_FAILED', reason: 'expired_or_canceled_card' }),
    });

    await expect(refund(input)).resolves.toEqual({
      outcome: 'REFUND_FAILED',
      reason: 'expired_or_canceled_card',
      requestedBy: ADMIN_ID,
    });

    expect(namesOf(input.orderId)).toEqual(['beginRefund', 'refundPayment', 'abandonRefund']);
    await exportHistory(input.orderId, 'refund-failed');
  });

  it('reads a failure without a reason as a null reason', async () => {
    const input = script(refundInput(), { refundPayment: () => Promise.resolve({ outcome: 'REFUND_FAILED' }) });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUND_FAILED', reason: null, requestedBy: ADMIN_ID });
  });

  it('ends at once on an order that is not paid', async () => {
    const input = script(refundInput(), { beginRefund: () => Promise.resolve('not_refundable') });

    await expect(refund(input)).resolves.toEqual({ outcome: 'NOT_REFUNDABLE', requestedBy: ADMIN_ID });

    expect(namesOf(input.orderId)).toEqual(['beginRefund']);
    await exportHistory(input.orderId, 'refund-not-refundable');
  });

  it('ends at once on an order already refunded', async () => {
    const input = script(refundInput(), { beginRefund: () => Promise.resolve('already_refunded') });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });
    expect(namesOf(input.orderId)).toEqual(['beginRefund']);
  });

  it('finishes the refund a run before it started', async () => {
    const input = script(refundInput(), { beginRefund: () => Promise.resolve('resumed') });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });
    expect(namesOf(input.orderId)).toEqual(['beginRefund', 'refundPayment', 'restockRefundedOrder', 'completeRefund']);
  });

  it('retries a participant conflict until it clears, never settling around it', async () => {
    const input = script(refundInput(), {
      refundPayment: (_input, attempt) =>
        attempt <= 2 ? Promise.reject(conflict()) : Promise.resolve({ outcome: 'REFUNDED' }),
      restockRefundedOrder: (_input, attempt) =>
        attempt <= 2 ? Promise.reject(conflict()) : Promise.resolve('APPLIED'),
    });

    await expect(refund(input)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });

    expect(inputsOf(input.orderId, 'refundPayment')).toHaveLength(3);
    expect(inputsOf(input.orderId, 'restockRefundedOrder')).toHaveLength(3);
    expect(inputsOf(input.orderId, 'completeRefund')).toHaveLength(1);
  });

  it('joins a second admin to the run already open, which keeps the first admin', async () => {
    const paymentGate = hold({ outcome: 'REFUNDED' });
    const first = script(refundInput(ADMIN_ID), { refundPayment: paymentGate.impl });
    const second: RefundOrderInput = { ...first, requestedBy: OTHER_ADMIN_ID };

    const firstRun = await start(first);
    await paymentGate.started;
    const secondRun = await start(second);
    paymentGate.release();

    expect(secondRun.firstExecutionRunId).toBe(firstRun.firstExecutionRunId);
    await expect(resultOf(first.orderId)).resolves.toEqual({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });
    expect(namesOf(first.orderId).filter((name) => name === 'beginRefund')).toHaveLength(1);
  });

  it('opens a new run over a closed one, which finds the order already refunded', async () => {
    const input = refundInput();
    await refund(input);
    scripts.set(input.orderId, { beginRefund: () => Promise.resolve('already_refunded') });

    await expect(refund({ ...input, requestedBy: OTHER_ADMIN_ID })).resolves.toEqual({
      outcome: 'REFUNDED',
      requestedBy: OTHER_ADMIN_ID,
    });
    expect(inputsOf(input.orderId, 'refundPayment')).toHaveLength(1);
  });
});
