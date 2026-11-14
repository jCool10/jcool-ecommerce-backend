import {
  ServiceError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  type Client,
} from '@temporalio/client';
import {
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
} from '../../application/ports/checkout-saga-engine.port';
import { isDeadlineExceeded, toEngineError, withinDeadline } from './temporal-engine-call';

const grpc = (code: number) => Object.assign(new Error(`grpc ${code}`), { code });

describe('temporal engine call', () => {
  describe('toEngineError', () => {
    it.each([
      ['an update past its deadline', new WorkflowUpdateRPCTimeoutOrCancelledError('timed out', { cause: grpc(4) })],
      ['DEADLINE_EXCEEDED', new ServiceError('failed', { cause: grpc(4) })],
      ['CANCELLED, the server ending the call at its deadline', new ServiceError('failed', { cause: grpc(1) })],
      ['RESOURCE_EXHAUSTED', new ServiceError('failed', { cause: grpc(8) })],
      ['FAILED_PRECONDITION', new ServiceError('failed', { cause: grpc(9) })],
      ['UNAVAILABLE', new ServiceError('failed', { cause: grpc(14) })],
    ])('maps %s to unavailable, keeping the SDK error as the cause', (_case, error) => {
      const mapped = toEngineError(error, 'order-1', null);

      expect(mapped).toBeInstanceOf(CheckoutEngineUnavailableError);
      expect(mapped).toMatchObject({ cause: error });
    });

    it('maps the closed-run error it was told about, and only that one', () => {
      const notFound = new WorkflowNotFoundError('closed', 'refund-order-1', undefined);
      const started = new WorkflowExecutionAlreadyStartedError('started', 'refund-order-1', 'RefundOrder');

      expect(toEngineError(notFound, 'order-1', WorkflowNotFoundError)).toEqual(new CheckoutSagaClosedError('order-1'));
      expect(toEngineError(started, 'order-1', WorkflowNotFoundError)).toBe(started);
      expect(toEngineError(notFound, 'order-1', null)).toBe(notFound);
    });

    it.each([
      ['a service error about the request', new ServiceError('bad', { cause: grpc(3) })],
      ['a service error without a cause', new ServiceError('bad')],
      ['anything else', new TypeError('bug')],
    ])('passes %s through untouched', (_case, error) => {
      expect(toEngineError(error, 'order-1', null)).toBe(error);
    });
  });

  // The server enforces the same grpc-timeout and resets the stream with CANCEL when its timer wins the race.
  it('reads DEADLINE_EXCEEDED or CANCELLED, and only those, as the call running out of its deadline', () => {
    expect(isDeadlineExceeded(new ServiceError('slow', { cause: grpc(4) }))).toBe(true);
    expect(isDeadlineExceeded(new ServiceError('Call cancelled', { cause: grpc(1) }))).toBe(true);
    expect(isDeadlineExceeded(new ServiceError('down', { cause: grpc(14) }))).toBe(false);
    expect(isDeadlineExceeded(new WorkflowUpdateRPCTimeoutOrCancelledError('timed out'))).toBe(false);
    expect(isDeadlineExceeded(new Error('deadline'))).toBe(false);
  });

  describe('withinDeadline', () => {
    const NOW = Date.parse('2026-11-09T00:00:00.000Z');
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
    afterEach(() => vi.useRealTimers());

    const clientWith = (withDeadline: (deadline: number, fn: () => Promise<unknown>) => Promise<unknown>) =>
      ({ connection: { withDeadline } }) as unknown as Client;

    it('runs the call under one absolute deadline and hands back its answer', async () => {
      const withDeadline = vi.fn((_deadline: number, fn: () => Promise<unknown>) => fn());

      await expect(
        withinDeadline(
          clientWith(withDeadline),
          2500,
          () => Promise.resolve('done'),
          (error) => error,
        ),
      ).resolves.toBe('done');
      expect(withDeadline).toHaveBeenCalledWith(NOW + 2500, expect.any(Function));
    });

    it('throws what the mapping makes of a failure', async () => {
      const failure = new ServiceError('down', { cause: grpc(14) });
      const mapped = new Error('mapped');

      await expect(
        withinDeadline(
          clientWith(() => Promise.reject(failure)),
          1000,
          () => Promise.resolve(),
          (error) => (error === failure ? mapped : error),
        ),
      ).rejects.toBe(mapped);
    });
  });
});
