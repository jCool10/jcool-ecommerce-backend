import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Client, Connection, WithStartWorkflowOperation, WorkflowUpdateFailedError } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { CancelBy, CheckoutSagaMode, PaymentAuthorization } from '../../src/modules/order/domain/checkout-saga';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import {
  CANCEL_REJECTED_FAILURE,
  CANCEL_UPDATE_ID,
  CHECKOUT_SAGA_WORKFLOW,
  RESERVE_UPDATE_ID,
  cancelUpdate,
  checkoutDeadlineKey,
  checkoutStepKey,
  checkoutWorkflowId,
  paymentAuthorizedSignal,
  reserveUpdate,
  stateQuery,
  type CheckoutSagaActivityFunctions,
  type CheckoutSagaInput,
} from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { installTemporalRuntime } from '../../src/modules/order/infrastructure/temporal/temporal-runtime';
import { sleep } from '../setup/sleep';
import { TEMPORAL_TEST_NAMESPACE } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

// The workflow against stub activities on the real dev server: every transition of the saga, with
// short settings so deadlines and retries take seconds. Set CHECKOUT_SAGA_HISTORY_OUT to export the
// histories the replay spec checks.

type Activities = CheckoutSagaActivityFunctions;
type ActivityName = keyof Activities;
type Script = Partial<Record<ActivityName, (input: never, attempt: number) => Promise<unknown>>>;

const TOTAL = 250_000;
const SETTINGS = {
  tryTimeoutMs: 1_000,
  authGraceMs: 1_000,
  activityTimeoutMs: 2_000,
  retryBaseMs: 50,
  retryCapMs: 200,
};
const HISTORY_OUT = process.env.CHECKOUT_SAGA_HISTORY_OUT;

const DEFAULTS: Required<Script> = {
  tryReserve: () => Promise.resolve('RESERVED'),
  applyTryResult: () => Promise.resolve('applied'),
  applyOrderChange: () => Promise.resolve('applied'),
  verifyAuthorization: () => Promise.resolve('VERIFIED'),
  commitStock: () => Promise.resolve('APPLIED'),
  capturePayment: () => Promise.resolve('CAPTURED'),
  releaseStock: () => Promise.resolve(),
  restock: () => Promise.resolve(),
  cancelPayment: () => Promise.resolve(),
  loadLateAuthorizationContext: () => Promise.resolve(OrderStatus.CANCELLED),
};

interface Call {
  name: ActivityName;
  input: Record<string, unknown>;
}

describe('CheckoutSaga workflow (dev server, stub activities)', () => {
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
      activities: stubActivities(),
      maxConcurrentActivityTaskExecutions: 2,
      maxConcurrentLocalActivityExecutions: 2,
      shutdownGraceTime: '500ms',
      shutdownForceTime: '1s',
    });
    running = worker.run();
    connection = await Connection.connect({ address: inject('TEMPORAL_ADDRESS') });
    client = new Client({ connection, namespace: TEMPORAL_TEST_NAMESPACE });
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

  const sagaInput = (
    options: { mode?: CheckoutSagaMode; placedAgoMs?: number; deadlineInMs?: number } = {},
  ): CheckoutSagaInput => {
    const now = Date.now();
    return {
      mode: options.mode ?? 'checkout',
      orderId: randomUUID(),
      userId: 'user-1',
      lines: [{ skuId: 'sku-1', quantity: 2 }],
      totalMinor: TOTAL,
      currency: 'VND',
      placedAt: new Date(now - (options.placedAgoMs ?? 0)).toISOString(),
      deadlineAt: new Date(now + (options.deadlineInMs ?? 30_000)).toISOString(),
      holdUntil: new Date(now + 120_000).toISOString(),
      settings: SETTINGS,
    };
  };

  const startOptions = (input: CheckoutSagaInput) => ({
    workflowId: checkoutWorkflowId(input.orderId),
    taskQueue,
    args: [input],
    typedSearchAttributes: [
      { key: checkoutStepKey, value: input.mode === 'checkout' ? 'RESERVING' : 'COMPENSATING' },
      { key: checkoutDeadlineKey, value: new Date(input.deadlineAt) },
    ],
  });

  const script = (input: CheckoutSagaInput, activities: Script): CheckoutSagaInput => {
    scripts.set(input.orderId, activities);
    return input;
  };

  const reserve = (input: CheckoutSagaInput): Promise<string> => {
    started.push(input.orderId);
    return client.workflow.executeUpdateWithStart(reserveUpdate, {
      startWorkflowOperation: new WithStartWorkflowOperation(CHECKOUT_SAGA_WORKFLOW, {
        ...startOptions(input),
        workflowIdConflictPolicy: 'USE_EXISTING',
      }),
      updateId: RESERVE_UPDATE_ID,
    });
  };

  const startLate = async (input: CheckoutSagaInput, authorization: PaymentAuthorization): Promise<void> => {
    started.push(input.orderId);
    await client.workflow.signalWithStart(CHECKOUT_SAGA_WORKFLOW, {
      ...startOptions(input),
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      signal: paymentAuthorizedSignal,
      signalArgs: [authorization],
    });
  };

  const handleOf = (orderId: string) => client.workflow.getHandle(checkoutWorkflowId(orderId));
  const viewOf = (orderId: string) => handleOf(orderId).query(stateQuery);
  const resultOf = (orderId: string): Promise<string> => handleOf(orderId).result();
  const authorize = (orderId: string, authorization: PaymentAuthorization) =>
    handleOf(orderId).signal(paymentAuthorizedSignal, authorization);
  const cancel = (orderId: string, by: CancelBy = 'buyer', updateId = CANCEL_UPDATE_ID) =>
    handleOf(orderId).executeUpdate(cancelUpdate, { args: [{ by }], updateId });

  const authorization = (overrides: Partial<PaymentAuthorization> = {}): PaymentAuthorization => ({
    paymentId: 'pay-1',
    amountMinor: TOTAL,
    currency: 'VND',
    authorizedAt: new Date().toISOString(),
    ...overrides,
  });

  const namesOf = (orderId: string): ActivityName[] => (calls.get(orderId) ?? []).map((call) => call.name);
  const inputsOf = (orderId: string, name: ActivityName) =>
    (calls.get(orderId) ?? []).filter((call) => call.name === name).map((call) => call.input);
  const COMPENSATIONS: ActivityName[] = ['releaseStock', 'restock', 'cancelPayment'];
  const compensationsOf = (orderId: string) =>
    (calls.get(orderId) ?? []).filter((call) => COMPENSATIONS.includes(call.name));

  /** Resolves `started` when the activity is entered; it then waits for `release`. */
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

  const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
      await sleep(50);
    }
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

  describe('reserve', () => {
    it('holds the stock and waits for the payment, the step searchable from the start', async () => {
      const tryGate = hold('RESERVED');
      const input = script(sagaInput(), { tryReserve: tryGate.impl });

      const outcome = reserve(input);
      await tryGate.started;
      const atStart = await handleOf(input.orderId).describe();
      expect(atStart.typedSearchAttributes.get(checkoutStepKey)).toBe('RESERVING');
      expect(atStart.typedSearchAttributes.get(checkoutDeadlineKey)).toEqual(new Date(input.deadlineAt));
      tryGate.release();

      await expect(outcome).resolves.toBe('HELD');
      expect(inputsOf(input.orderId, 'tryReserve')).toEqual([
        { orderId: input.orderId, lines: input.lines, holdUntil: input.holdUntil },
      ]);
      expect(inputsOf(input.orderId, 'applyTryResult')).toEqual([
        { orderId: input.orderId, outcome: 'HELD', reason: null },
      ]);
      await expect(viewOf(input.orderId)).resolves.toEqual({
        step: 'AWAITING_AUTH',
        orderStatus: OrderStatus.PENDING,
        tryOutcome: 'HELD',
        pendingCompensations: [],
        deadlineAt: input.deadlineAt,
      });
      const after = await handleOf(input.orderId).describe();
      expect(after.typedSearchAttributes.get(checkoutStepKey)).toBe('AWAITING_AUTH');
    });

    it.each(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const)(
      'rejects the order and releases the stock on a %s Try',
      async (tryOutcome) => {
        const input = script(sagaInput(), { tryReserve: () => Promise.resolve(tryOutcome) });

        await expect(reserve(input)).resolves.toBe(tryOutcome);

        await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
        expect(inputsOf(input.orderId, 'applyTryResult')).toEqual([
          { orderId: input.orderId, outcome: tryOutcome, reason: 'saga:try_failed' },
        ]);
        expect(inputsOf(input.orderId, 'releaseStock')).toEqual([{ orderId: input.orderId, reason: 'TRY_FAILED' }]);
        expect(namesOf(input.orderId)).not.toContain('applyOrderChange');
        if (tryOutcome === 'OUT_OF_STOCK') await exportHistory(input.orderId, 'try-out-of-stock');
      },
    );

    it('answers TIMEOUT when the Try outlives its budget', async () => {
      const input = script(sagaInput(), { tryReserve: () => sleep(1_500).then(() => 'RESERVED') });

      const begun = Date.now();
      await expect(reserve(input)).resolves.toBe('TIMEOUT');
      expect(Date.now() - begun).toBeLessThan(SETTINGS.tryTimeoutMs + 1_000);

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'applyTryResult')).toEqual([
        { orderId: input.orderId, outcome: 'TIMEOUT', reason: 'saga:try_timeout' },
      ]);
      expect(inputsOf(input.orderId, 'releaseStock')).toEqual([{ orderId: input.orderId, reason: 'TRY_TIMEOUT' }]);
    });

    it('answers ERROR on a Try fault, without retrying it', async () => {
      const input = script(sagaInput(), { tryReserve: () => Promise.reject(new Error('stock unreachable')) });

      await expect(reserve(input)).resolves.toBe('ERROR');

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'tryReserve')).toHaveLength(1);
      expect(inputsOf(input.orderId, 'releaseStock')).toEqual([{ orderId: input.orderId, reason: 'TRY_TIMEOUT' }]);
    });

    it('abandons a Try whose budget ran out before the run began', async () => {
      const input = sagaInput({ placedAgoMs: SETTINGS.tryTimeoutMs + 500 });

      await expect(reserve(input)).resolves.toBe('ABANDONED');

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(namesOf(input.orderId)).not.toContain('tryReserve');
      expect(inputsOf(input.orderId, 'applyTryResult')).toEqual([
        { orderId: input.orderId, outcome: 'ABANDONED', reason: 'saga:abandoned' },
      ]);
      expect(inputsOf(input.orderId, 'releaseStock')).toEqual([{ orderId: input.orderId, reason: 'ABANDONED' }]);
    });

    it('answers a repeated reserve with the recorded outcome, running the Try once', async () => {
      const input = script(sagaInput(), { tryReserve: () => Promise.resolve('OUT_OF_STOCK') });

      await expect(reserve(input)).resolves.toBe('OUT_OF_STOCK');
      await resultOf(input.orderId);
      await expect(reserve(input)).resolves.toBe('OUT_OF_STOCK');

      expect(inputsOf(input.orderId, 'tryReserve')).toHaveLength(1);
    });

    it('retries a failing compensation until it lands', async () => {
      const input = script(sagaInput(), {
        tryReserve: () => Promise.resolve('OUT_OF_STOCK'),
        releaseStock: (_input, attempt) =>
          attempt <= 2 ? Promise.reject(new Error('lock timeout')) : Promise.resolve(),
      });

      await reserve(input);

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'releaseStock')).toHaveLength(3);
    });
  });

  describe('authorization', () => {
    it('verifies, commits, captures and pays the order with the payment as its ref', async () => {
      const input = sagaInput();
      await reserve(input);

      await authorize(input.orderId, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
      expect(namesOf(input.orderId)).toEqual([
        'tryReserve',
        'applyTryResult',
        'verifyAuthorization',
        'applyOrderChange',
        'commitStock',
        'capturePayment',
        'applyOrderChange',
      ]);
      expect(inputsOf(input.orderId, 'verifyAuthorization')).toEqual([{ orderId: input.orderId, paymentId: 'pay-1' }]);
      expect(inputsOf(input.orderId, 'applyOrderChange')).toEqual([
        { orderId: input.orderId, from: [OrderStatus.PENDING], to: OrderStatus.CONFIRMING, reason: null },
        {
          orderId: input.orderId,
          from: [OrderStatus.CONFIRMING],
          to: OrderStatus.PAID,
          reason: 'saga:captured',
          paymentRef: 'pay-1',
        },
      ]);
      expect(compensationsOf(input.orderId)).toEqual([]);
      const description = await handleOf(input.orderId).describe();
      expect(description.typedSearchAttributes.get(checkoutStepKey)).toBe('COMPLETED');
      await exportHistory(input.orderId, 'completed');
    });

    it('drops a signal whose amount or currency is off, without asking payment', async () => {
      const input = sagaInput();
      await reserve(input);

      await authorize(input.orderId, authorization({ amountMinor: TOTAL - 1 }));
      await authorize(input.orderId, authorization({ currency: 'USD' }));
      await sleep(300);

      expect(namesOf(input.orderId)).not.toContain('verifyAuthorization');
      await expect(viewOf(input.orderId)).resolves.toMatchObject({ step: 'AWAITING_AUTH' });
    });

    it('commits nothing on a signal payment does not back, then pays on the real one', async () => {
      const verdicts = ['NOT_AUTHORIZED', 'PAYMENT_MISMATCH', 'VERIFIED'];
      const input = script(sagaInput(), {
        verifyAuthorization: (_input, attempt) => Promise.resolve(verdicts[attempt - 1]),
      });
      await reserve(input);

      for (const expected of [1, 2]) {
        await authorize(input.orderId, authorization({ paymentId: `forged-${expected}` }));
        await waitFor(() => inputsOf(input.orderId, 'verifyAuthorization').length === expected);
        await sleep(300);
        expect(namesOf(input.orderId)).not.toContain('commitStock');
        await expect(viewOf(input.orderId)).resolves.toMatchObject({ step: 'AWAITING_AUTH' });
      }

      await authorize(input.orderId, authorization({ paymentId: 'pay-real' }));

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
      expect(inputsOf(input.orderId, 'applyOrderChange').at(-1)).toMatchObject({ paymentRef: 'pay-real' });
    });

    it('pays an authorization that lands after the deadline but inside the grace window', async () => {
      const input = sagaInput({ deadlineInMs: 1_500 });
      await reserve(input);
      await sleep(1_500 + SETTINGS.authGraceMs / 2);

      await authorize(input.orderId, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
    });

    it('settles a capture that conflicts once, with no compensation', async () => {
      const input = script(sagaInput(), {
        capturePayment: (_input, attempt) =>
          attempt === 1 ? Promise.reject(new Error('capture CONFLICT')) : Promise.resolve('CAPTURED'),
      });
      await reserve(input);

      await authorize(input.orderId, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
      expect(inputsOf(input.orderId, 'capturePayment')).toHaveLength(2);
      expect(compensationsOf(input.orderId)).toEqual([]);
    });

    it('stays CAPTURING while the capture keeps conflicting, compensating nothing', async () => {
      const input = script(sagaInput(), { capturePayment: () => Promise.reject(new Error('capture CONFLICT')) });
      await reserve(input);

      await authorize(input.orderId, authorization());
      await waitFor(() => inputsOf(input.orderId, 'capturePayment').length >= 3);

      await expect(viewOf(input.orderId)).resolves.toMatchObject({ step: 'CAPTURING' });
      expect(compensationsOf(input.orderId)).toEqual([]);
    });

    it('fails the order and voids the payment when the stock commit conflicts', async () => {
      const input = script(sagaInput(), { commitStock: () => Promise.resolve('CONFLICT') });
      await reserve(input);

      await authorize(input.orderId, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'applyOrderChange').at(-1)).toEqual({
        orderId: input.orderId,
        from: [OrderStatus.CONFIRMING],
        to: OrderStatus.FAILED,
        reason: 'saga:commit_conflict',
      });
      expect(compensationsOf(input.orderId).map((call) => call.input)).toEqual([
        { orderId: input.orderId, reason: 'COMMIT_CONFLICT' },
      ]);
    });

    it('fails the order, restocks and voids the payment when nothing is left to capture', async () => {
      const input = script(sagaInput(), { capturePayment: () => Promise.resolve('NOT_CAPTURABLE') });
      await reserve(input);

      await authorize(input.orderId, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'applyOrderChange').at(-1)).toMatchObject({
        to: OrderStatus.FAILED,
        reason: 'saga:capture_failed',
      });
      expect(inputsOf(input.orderId, 'restock')).toEqual([{ orderId: input.orderId, reason: 'CAPTURE_FAILED' }]);
      expect(inputsOf(input.orderId, 'cancelPayment')).toEqual([{ orderId: input.orderId, reason: 'CAPTURE_FAILED' }]);
    });
  });

  describe('deadline', () => {
    it('expires an unpaid order, releasing the stock and voiding any payment', async () => {
      const input = sagaInput({ deadlineInMs: 1_000 });
      await reserve(input);

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');

      expect(inputsOf(input.orderId, 'applyOrderChange')).toEqual([
        { orderId: input.orderId, from: [OrderStatus.PENDING], to: OrderStatus.EXPIRED, reason: 'saga:expired' },
      ]);
      expect(inputsOf(input.orderId, 'releaseStock')).toEqual([{ orderId: input.orderId, reason: 'EXPIRED' }]);
      expect(inputsOf(input.orderId, 'cancelPayment')).toEqual([{ orderId: input.orderId, reason: 'EXPIRED' }]);
      await exportHistory(input.orderId, 'expired');
    });

    it('voids an authorization that lands after the grace window, while it compensates', async () => {
      const releaseGate = hold(undefined);
      const input = script(sagaInput({ deadlineInMs: 500 }), { releaseStock: releaseGate.impl });
      await reserve(input);
      await releaseGate.started;

      await authorize(input.orderId, authorization());
      await waitFor(() => inputsOf(input.orderId, 'cancelPayment').length === 2);
      releaseGate.release();

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'cancelPayment')).toEqual(
        expect.arrayContaining([
          { orderId: input.orderId, reason: 'EXPIRED' },
          { orderId: input.orderId, reason: 'LATE_AUTHORIZATION' },
        ]),
      );
      expect(namesOf(input.orderId)).not.toContain('verifyAuthorization');
    });
  });

  describe('cancel', () => {
    it.each([
      ['buyer', 'user:cancel'],
      ['admin', 'admin:cancel'],
    ] as const)('cancels for the %s and answers only once stock and payment are released', async (by, reason) => {
      let released = false;
      const input = script(sagaInput(), {
        releaseStock: () => sleep(300).then(() => void (released = true)),
      });
      await reserve(input);

      await expect(cancel(input.orderId, by)).resolves.toBe('CANCELLED');

      expect(released).toBe(true);
      expect(inputsOf(input.orderId, 'applyOrderChange')).toEqual([
        { orderId: input.orderId, from: [OrderStatus.PENDING], to: OrderStatus.CANCELLED, reason },
      ]);
      expect(inputsOf(input.orderId, 'cancelPayment')).toEqual([{ orderId: input.orderId, reason: 'CANCELLED' }]);
      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      if (by === 'buyer') await exportHistory(input.orderId, 'cancelled');
    });

    it('answers a repeated cancel with CANCELLED and compensates once', async () => {
      const releaseGate = hold(undefined);
      const input = script(sagaInput(), { releaseStock: releaseGate.impl });
      await reserve(input);

      const first = cancel(input.orderId);
      await releaseGate.started;
      // Accepted before the release: an update still on its way when the run closes is aborted.
      const again = await handleOf(input.orderId).startUpdate(cancelUpdate, {
        args: [{ by: 'buyer' }],
        updateId: 'cancel-again',
        waitForStage: 'ACCEPTED',
      });
      releaseGate.release();

      await expect(Promise.all([first, again.result()])).resolves.toEqual(['CANCELLED', 'CANCELLED']);
      expect(inputsOf(input.orderId, 'releaseStock')).toHaveLength(1);
    });

    it('refuses a cancel once the payment is being taken', async () => {
      const commitGate = hold('APPLIED');
      const captureGate = hold('CAPTURED');
      const input = script(sagaInput(), { commitStock: commitGate.impl, capturePayment: captureGate.impl });
      await reserve(input);
      await authorize(input.orderId, authorization());

      for (const [gate, step] of [
        [commitGate, 'COMMITTING_STOCK'],
        [captureGate, 'CAPTURING'],
      ] as const) {
        await gate.started;
        const rejection = await cancel(input.orderId).then(
          () => null,
          (error: unknown) => error,
        );
        expect(rejection).toBeInstanceOf(WorkflowUpdateFailedError);
        expect((rejection as WorkflowUpdateFailedError).cause).toMatchObject({
          type: CANCEL_REJECTED_FAILURE,
          details: [step],
        });
        gate.release();
      }

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
      expect(compensationsOf(input.orderId)).toEqual([]);
    });

    it('wins over a verification still running, and the late verdict commits nothing', async () => {
      const verifyGate = hold('VERIFIED');
      const input = script(sagaInput(), { verifyAuthorization: verifyGate.impl });
      await reserve(input);
      await authorize(input.orderId, authorization());
      await verifyGate.started;

      await expect(cancel(input.orderId)).resolves.toBe('CANCELLED');
      verifyGate.release();

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(namesOf(input.orderId)).not.toContain('commitStock');
      expect(inputsOf(input.orderId, 'applyOrderChange')).toHaveLength(1);
    });
  });

  describe('late authorization', () => {
    it('voids an authorization for an order that was never paid', async () => {
      const input = script(sagaInput({ mode: 'lateAuthorization' }), {
        loadLateAuthorizationContext: () => Promise.resolve(OrderStatus.EXPIRED),
      });

      await startLate(input, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'cancelPayment')).toEqual([
        { orderId: input.orderId, reason: 'LATE_AUTHORIZATION' },
      ]);
      expect(namesOf(input.orderId)).not.toContain('applyOrderChange');
      expect(namesOf(input.orderId)).not.toContain('verifyAuthorization');
      await exportHistory(input.orderId, 'late-authorization');
    });

    it('voids one for an order that does not exist', async () => {
      const input = script(sagaInput({ mode: 'lateAuthorization' }), {
        loadLateAuthorizationContext: () => Promise.resolve(null),
      });

      await startLate(input, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'cancelPayment')).toHaveLength(1);
      // No row is not proof of PAID: capturing here would charge a buyer with no order to show for it.
      expect(namesOf(input.orderId)).not.toContain('capturePayment');
    });

    it('remembers a payment signalled while the order loads, and voids the order once', async () => {
      const loadGate = hold(OrderStatus.EXPIRED);
      const cancelGate = hold(undefined);
      const input = script(sagaInput({ mode: 'lateAuthorization' }), {
        loadLateAuthorizationContext: loadGate.impl,
        cancelPayment: cancelGate.impl,
      });
      await startLate(input, authorization());
      await loadGate.started;

      await authorize(input.orderId, authorization({ paymentId: 'pay-2' }));
      loadGate.release();
      await cancelGate.started;
      await authorize(input.orderId, authorization({ paymentId: 'pay-2' }));
      // A query is answered only after the signal before it has been applied.
      await viewOf(input.orderId);
      cancelGate.release();

      await expect(resultOf(input.orderId)).resolves.toBe('COMPENSATED');
      expect(inputsOf(input.orderId, 'cancelPayment')).toHaveLength(1);
    });

    it('leaves a paid order alone', async () => {
      const input = script(sagaInput({ mode: 'lateAuthorization' }), {
        loadLateAuthorizationContext: () => Promise.resolve(OrderStatus.PAID),
      });

      await startLate(input, authorization());

      await expect(resultOf(input.orderId)).resolves.toBe('COMPLETED');
      expect(namesOf(input.orderId)).toEqual(['loadLateAuthorizationContext']);
    });
  });
});
