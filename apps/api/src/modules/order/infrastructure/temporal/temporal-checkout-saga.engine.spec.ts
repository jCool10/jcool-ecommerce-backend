import type { ConfigService } from '@nestjs/config';
import {
  ApplicationFailure,
  ServiceError,
  WithStartWorkflowOperation,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  type Client,
} from '@temporalio/client';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import {
  CheckoutCancelRejectedError,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaStart,
} from '../../application/ports/checkout-saga-engine.port';
import {
  CHECKOUT_SAGA_WORKFLOW,
  cancelUpdate,
  checkoutDeadlineKey,
  checkoutStepKey,
  paymentAuthorizedSignal,
  reserveUpdate,
} from './checkout-saga.contract';
import { TemporalCheckoutSagaEngine } from './temporal-checkout-saga.engine';

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
const ORDER_ID = 'order-1';

const CONFIG = {
  holdSafetySec: 900,
  tryTimeoutMs: 3000,
  reserveWaitMs: 6000,
  cancelWaitMs: 10_000,
  authGraceSec: 180,
  activityTimeoutMs: 60_000,
  retryBaseMs: 1000,
  retryCapMs: 300_000,
  temporal: { taskQueue: 'checkout-saga-test' },
} as CheckoutSagaConfig;

const start = (overrides: Partial<CheckoutSagaStart> = {}): CheckoutSagaStart => ({
  mode: 'checkout',
  orderId: ORDER_ID,
  userId: 'user-1',
  lines: [{ skuId: 'sku-1', quantity: 2 }],
  totalMinor: 20_000,
  currency: 'VND',
  placedAt: new Date(NOW),
  deadlineAt: new Date(NOW + 3_600_000),
  ...overrides,
});

const expectedInput = (mode: CheckoutSagaStart['mode']) => ({
  mode,
  orderId: ORDER_ID,
  userId: 'user-1',
  lines: [{ skuId: 'sku-1', quantity: 2 }],
  totalMinor: 20_000,
  currency: 'VND',
  placedAt: '2026-10-21T10:00:00.000Z',
  deadlineAt: '2026-10-21T11:00:00.000Z',
  holdUntil: '2026-10-21T11:15:00.000Z',
  settings: {
    tryTimeoutMs: 3000,
    authGraceMs: 180_000,
    activityTimeoutMs: 60_000,
    retryBaseMs: 1000,
    retryCapMs: 300_000,
  },
});

const searchAttributes = (step: string) => [
  { key: checkoutStepKey, value: step },
  { key: checkoutDeadlineKey, value: new Date(NOW + 3_600_000) },
];

describe('TemporalCheckoutSagaEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = () => {
    // Records the deadline each workflow call ran under, so a call made outside withDeadline shows.
    let activeDeadline: number | Date | undefined;
    const calledUnder: (number | Date | undefined)[] = [];
    const recorded =
      <T>(value: T) =>
      () => {
        calledUnder.push(activeDeadline);
        return Promise.resolve(value);
      };
    const handle = { executeUpdate: vi.fn(recorded('CANCELLED')) };
    const listed = (workflowIds: string[]) =>
      (async function* () {
        calledUnder.push(activeDeadline);
        for (const workflowId of workflowIds) yield await Promise.resolve({ workflowId });
      })();
    const workflow = {
      executeUpdateWithStart: vi.fn(recorded('HELD')),
      getHandle: vi.fn(() => handle),
      signalWithStart: vi.fn(recorded({})),
      start: vi.fn(recorded({})),
      list: vi.fn((_options: { query: string }): AsyncIterable<{ workflowId: string }> => listed([])),
    };
    const connection = {
      withDeadline: async <R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> => {
        activeDeadline = deadline;
        try {
          return await fn();
        } finally {
          activeDeadline = undefined;
        }
      },
    };
    const config = { getOrThrow: vi.fn(() => CONFIG) };
    const engine = new TemporalCheckoutSagaEngine(
      { workflow, connection } as unknown as Client,
      config as unknown as ConfigService,
    );
    return { engine, workflow, handle, calledUnder, config, listed };
  };

  describe('runningOrderIds', () => {
    const IDS = ['6577090077287424', '6577089942944768'];

    it('asks visibility for the open runs of exactly these orders on its own task queue', async () => {
      const { engine, workflow } = build();

      await engine.runningOrderIds(IDS);

      expect(workflow.list).toHaveBeenCalledExactlyOnceWith({
        query:
          "WorkflowType = 'CheckoutSaga' AND TaskQueue = 'checkout-saga-test' AND ExecutionStatus = 'Running' AND " +
          "WorkflowId IN ('checkout-6577090077287424', 'checkout-6577089942944768')",
      });
    });

    it('answers with order ids, read under a deadline', async () => {
      const { engine, workflow, calledUnder, listed } = build();
      workflow.list.mockReturnValue(listed(['checkout-6577089942944768']));

      await expect(engine.runningOrderIds(IDS)).resolves.toEqual(new Set(['6577089942944768']));
      expect(calledUnder).toEqual([NOW + 5000]);
    });

    it('asks nothing for no ids', async () => {
      const { engine, workflow } = build();

      await expect(engine.runningOrderIds([])).resolves.toEqual(new Set());
      expect(workflow.list).not.toHaveBeenCalled();
    });

    // The ids are spliced into the query string.
    it('refuses an id that is not a snowflake before building a query from it', async () => {
      const { engine, workflow } = build();

      await expect(engine.runningOrderIds(["1' OR WorkflowId != '"])).rejects.toThrow(/not an order id/);
      expect(workflow.list).not.toHaveBeenCalled();
    });

    it('refuses more ids than one visibility query takes', async () => {
      const { engine } = build();
      const ids = Array.from({ length: 201 }, (_, index) => String(6_577_090_077_287_424n + BigInt(index)));

      await expect(engine.runningOrderIds(ids)).rejects.toThrow(RangeError);
    });
  });

  it('reads its settings from the checkoutSaga config namespace', () => {
    const { config } = build();

    expect(config.getOrThrow).toHaveBeenCalledWith('checkoutSaga');
  });

  it('reserves with Update-with-Start: fixed update id, existing run reused, closed id not reopened', async () => {
    const { engine, workflow, calledUnder } = build();

    await expect(engine.reserve(start())).resolves.toBe('HELD');

    const [definition, options] = workflow.executeUpdateWithStart.mock.calls[0] as unknown as [
      unknown,
      { updateId: string; startWorkflowOperation: WithStartWorkflowOperation<never> },
    ];
    expect(definition).toBe(reserveUpdate);
    expect(options.updateId).toBe('reserve');
    expect(options.startWorkflowOperation).toBeInstanceOf(WithStartWorkflowOperation);
    expect(options.startWorkflowOperation.workflowTypeOrFunc).toBe(CHECKOUT_SAGA_WORKFLOW);
    expect(options.startWorkflowOperation.options).toEqual({
      workflowId: 'checkout-order-1',
      taskQueue: 'checkout-saga-test',
      args: [expectedInput('checkout')],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'USE_EXISTING',
      typedSearchAttributes: searchAttributes('RESERVING'),
    });
    expect(calledUnder).toEqual([NOW + 6000]);
  });

  it('cancels through the fixed-id update on the order workflow, waiting at most the cancel budget', async () => {
    const { engine, workflow, handle, calledUnder } = build();

    await expect(engine.cancel(ORDER_ID, 'admin')).resolves.toBeUndefined();

    expect(workflow.getHandle).toHaveBeenCalledWith('checkout-order-1');
    expect(handle.executeUpdate).toHaveBeenCalledWith(cancelUpdate, { args: [{ by: 'admin' }], updateId: 'cancel' });
    expect(calledUnder).toEqual([NOW + 10_000]);
  });

  it('signals an authorization with start, so a closed saga gets a late-authorization run', async () => {
    const { engine, workflow, calledUnder } = build();
    const authorization = {
      paymentId: 'pay-1',
      amountMinor: 20_000,
      currency: 'VND',
      authorizedAt: '2026-10-21T10:05:00.000Z',
    };

    await expect(engine.notifyAuthorized(start({ mode: 'lateAuthorization' }), authorization)).resolves.toBeUndefined();

    expect(workflow.signalWithStart).toHaveBeenCalledWith(CHECKOUT_SAGA_WORKFLOW, {
      workflowId: 'checkout-order-1',
      taskQueue: 'checkout-saga-test',
      args: [expectedInput('lateAuthorization')],
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      typedSearchAttributes: searchAttributes('COMPENSATING'),
      signal: paymentAuthorizedSignal,
      signalArgs: [authorization],
    });
    expect(calledUnder).toEqual([NOW + 5000]);
  });

  it('ensures a run without starting a second one or reopening a closed id', async () => {
    const { engine, workflow, calledUnder } = build();

    await expect(engine.ensureStarted(start())).resolves.toBeUndefined();

    expect(workflow.start).toHaveBeenCalledWith(CHECKOUT_SAGA_WORKFLOW, {
      workflowId: 'checkout-order-1',
      taskQueue: 'checkout-saga-test',
      args: [expectedInput('checkout')],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'USE_EXISTING',
      typedSearchAttributes: searchAttributes('RESERVING'),
    });
    expect(calledUnder).toEqual([NOW + 5000]);
  });

  describe('error mapping', () => {
    const grpc = (code: number) => Object.assign(new Error(`grpc ${code}`), { code });
    const cancelRejected = (step: unknown) =>
      new WorkflowUpdateFailedError(
        'Workflow Update failed',
        ApplicationFailure.create({ type: 'CancelRejected', message: 'not now', details: [step], nonRetryable: true }),
      );

    // Every engine call goes through one mapping, so each case runs against all four.
    const calls = [
      ['reserve', (engine: TemporalCheckoutSagaEngine) => engine.reserve(start())],
      ['cancel', (engine: TemporalCheckoutSagaEngine) => engine.cancel(ORDER_ID, 'buyer')],
      [
        'notifyAuthorized',
        (engine: TemporalCheckoutSagaEngine) =>
          engine.notifyAuthorized(start(), { paymentId: 'p', amountMinor: 1, currency: 'VND', authorizedAt: '' }),
      ],
      ['ensureStarted', (engine: TemporalCheckoutSagaEngine) => engine.ensureStarted(start())],
      ['runningOrderIds', (engine: TemporalCheckoutSagaEngine) => engine.runningOrderIds(['6577090077287424'])],
    ] as const;

    const failWith = (error: Error) => {
      const built = build();
      built.workflow.executeUpdateWithStart.mockRejectedValue(error);
      built.handle.executeUpdate.mockRejectedValue(error);
      built.workflow.signalWithStart.mockRejectedValue(error);
      built.workflow.start.mockRejectedValue(error);
      // A listing fails while it is being read, not when it is asked for.
      built.workflow.list.mockReturnValue(
        (async function* () {
          yield await Promise.reject<never>(error);
        })(),
      );
      return built.engine;
    };

    const unavailable: [string, Error][] = [
      ['an update past its deadline', new WorkflowUpdateRPCTimeoutOrCancelledError('timed out', { cause: grpc(4) })],
      ['UNAVAILABLE', new ServiceError('Update-With-Start failed', { cause: grpc(14) })],
      ['DEADLINE_EXCEEDED', new ServiceError('start failed', { cause: grpc(4) })],
      ['RESOURCE_EXHAUSTED', new ServiceError('start failed', { cause: grpc(8) })],
      ['FAILED_PRECONDITION', new ServiceError('Update-With-Start failed', { cause: grpc(9) })],
    ];
    describe.each(calls)('%s', (_name, invoke) => {
      it.each(unavailable)('maps %s to unavailable, keeping the SDK error as the cause', async (_case, error) => {
        const failure = await invoke(failWith(error)).catch((thrown: unknown) => thrown);

        expect(failure).toBeInstanceOf(CheckoutEngineUnavailableError);
        expect(failure).toMatchObject({ cause: error });
      });

      it.each([
        ['a service error with a code that is not about availability', new ServiceError('bad', { cause: grpc(3) })],
        ['a service error without a cause', new ServiceError('bad')],
        [
          'an update failure that is not a cancel rejection',
          new WorkflowUpdateFailedError('failed', new Error('boom')),
        ],
        ['anything else', new TypeError('bug')],
      ])('rethrows %s untouched', async (_case, error) => {
        await expect(invoke(failWith(error))).rejects.toBe(error);
      });
    });

    const invokeOf = Object.fromEntries(calls) as Record<
      (typeof calls)[number][0],
      (engine: TemporalCheckoutSagaEngine) => Promise<unknown>
    >;
    const notFound = new WorkflowNotFoundError('workflow execution already completed', 'checkout-order-1', undefined);
    const alreadyStarted = new WorkflowExecutionAlreadyStartedError(
      'already started',
      'checkout-order-1',
      'CheckoutSaga',
    );

    it.each([
      ['reserve', alreadyStarted],
      ['cancel', notFound],
      ['ensureStarted', alreadyStarted],
    ] as const)('maps the closed-run error of %s to a closed saga', async (name, error) => {
      await expect(invokeOf[name](failWith(error))).rejects.toEqual(new CheckoutSagaClosedError(ORDER_ID));
    });

    // Where a call cannot meet a closed run, the same class means something else, a missing
    // namespace say, and must not read as "nothing left to do".
    it.each([
      ['reserve', notFound],
      ['cancel', alreadyStarted],
      ['notifyAuthorized', notFound],
      ['notifyAuthorized', alreadyStarted],
      ['ensureStarted', notFound],
      ['runningOrderIds', notFound],
    ] as const)('rethrows %s failing with %s untouched', async (name, error) => {
      await expect(invokeOf[name](failWith(error))).rejects.toBe(error);
    });

    it('maps a cancel rejection to the step the saga was at', async () => {
      const failure = await failWith(cancelRejected('CAPTURING'))
        .cancel(ORDER_ID, 'buyer')
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(CheckoutCancelRejectedError);
      expect(failure).toMatchObject({ orderId: ORDER_ID, step: 'CAPTURING' });
    });

    it('keeps a cancel rejection whose step it cannot read, with no step', async () => {
      await expect(failWith(cancelRejected('NOT_A_STEP')).cancel(ORDER_ID, 'buyer')).rejects.toMatchObject({
        name: 'CheckoutCancelRejectedError',
        step: null,
      });
    });
  });
});
