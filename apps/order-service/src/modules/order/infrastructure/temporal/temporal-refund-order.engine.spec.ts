import type { ConfigService } from '@nestjs/config';
import { ServiceError, WorkflowFailedError, type Client } from '@temporalio/client';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import { CheckoutEngineUnavailableError } from '../../application/ports/checkout-saga-engine.port';
import { REFUND_ORDER_WORKFLOW } from './refund-order.contract';
import { START_WAIT_MS } from './temporal-checkout-saga.engine';
import { TemporalRefundOrderEngine } from './temporal-refund-order.engine';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ORDER_ID = '137465797020397179';
const ADMIN_ID = '137465797020397182';

const CONFIG = {
  activityTimeoutMs: 60_000,
  retryBaseMs: 1000,
  retryCapMs: 300_000,
  refund: { waitMs: 10_000, pendingPollBaseMs: 60_000, pendingPollMaxMs: 3_600_000 },
  temporal: { taskQueue: 'checkout-saga-test' },
} as CheckoutSagaConfig;

const grpc = (code: number) => new ServiceError(`grpc ${code}`, { cause: Object.assign(new Error('rpc'), { code }) });

describe('TemporalRefundOrderEngine', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => vi.useRealTimers());

  const build = () => {
    let activeDeadline: number | Date | undefined;
    const calls: { call: string; deadline: number | Date | undefined }[] = [];
    const handle = {
      result: vi.fn((): Promise<unknown> => {
        calls.push({ call: 'result', deadline: activeDeadline });
        return Promise.resolve({ outcome: 'REFUNDED', requestedBy: ADMIN_ID });
      }),
    };
    const workflow = {
      start: vi.fn((_workflow: string, _options: unknown): Promise<typeof handle> => {
        calls.push({ call: 'start', deadline: activeDeadline });
        return Promise.resolve(handle);
      }),
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
    const client = { workflow, connection } as unknown as Client;
    const config = { getOrThrow: vi.fn(() => CONFIG) } as unknown as ConfigService;
    return { engine: new TemporalRefundOrderEngine(client, config), workflow, handle, calls };
  };

  it('starts or joins refund-{orderId} with the admin and the snapshotted settings, under the start budget', async () => {
    const { engine, workflow, calls } = build();

    await engine.refund(ORDER_ID, ADMIN_ID);

    expect(workflow.start).toHaveBeenCalledExactlyOnceWith(REFUND_ORDER_WORKFLOW, {
      workflowId: `refund-${ORDER_ID}`,
      taskQueue: 'checkout-saga-test',
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      args: [
        {
          orderId: ORDER_ID,
          requestedBy: ADMIN_ID,
          settings: {
            activityTimeoutMs: 60_000,
            retryBaseMs: 1000,
            retryCapMs: 300_000,
            pendingPollBaseMs: 60_000,
            pendingPollMaxMs: 3_600_000,
          },
        },
      ],
    });
    expect(calls).toEqual([
      { call: 'start', deadline: NOW + START_WAIT_MS },
      { call: 'result', deadline: NOW + 10_000 },
    ]);
  });

  it.each([
    { outcome: 'REFUNDED', requestedBy: ADMIN_ID },
    { outcome: 'REFUND_FAILED', reason: 'charge_disputed', requestedBy: ADMIN_ID },
    { outcome: 'NOT_REFUNDABLE', requestedBy: 'another-admin' },
  ])('hands back the run’s result $outcome', async (result) => {
    const { engine, handle } = build();
    handle.result.mockResolvedValue(result);

    await expect(engine.refund(ORDER_ID, ADMIN_ID)).resolves.toEqual(result);
  });

  it.each([4, 1])('answers RUNNING when the wait for a confirmed run runs out with gRPC code %i', async (code) => {
    const { engine, handle } = build();
    handle.result.mockRejectedValue(grpc(code));

    await expect(engine.refund(ORDER_ID, ADMIN_ID)).resolves.toEqual({ outcome: 'RUNNING' });
  });

  it.each([8, 9, 14])('reads gRPC code %i on the wait as unavailable', async (code) => {
    const { engine, handle } = build();
    const failure = grpc(code);
    handle.result.mockRejectedValue(failure);

    await expect(engine.refund(ORDER_ID, ADMIN_ID)).rejects.toEqual(
      new CheckoutEngineUnavailableError({ cause: failure }),
    );
  });

  it.each([1, 4, 8, 9, 14])('reads gRPC code %i on the start as unavailable, never as RUNNING', async (code) => {
    const { engine, workflow, handle } = build();
    const failure = grpc(code);
    workflow.start.mockRejectedValue(failure);

    await expect(engine.refund(ORDER_ID, ADMIN_ID)).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);
    expect(handle.result).not.toHaveBeenCalled();
  });

  // The workflow never fails by design: every activity retries until it lands. A failed run is a bug.
  it('lets a failed run through untouched', async () => {
    const { engine, handle } = build();
    const failure = new WorkflowFailedError('workflow failed', undefined, 'NON_RETRYABLE_FAILURE');
    handle.result.mockRejectedValue(failure);

    await expect(engine.refund(ORDER_ID, ADMIN_ID)).rejects.toBe(failure);
  });
});
