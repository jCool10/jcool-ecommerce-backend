import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { AdvanceCheckoutSagaUseCase } from '../use-cases/advance-checkout-saga.use-case';
import { SagaKickExecutor } from './saga-kick.executor';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build(config: Record<string, unknown> = { 'saga.kickConcurrency': 2 }) {
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const execute = vi.fn((orderId: string) => {
    const kick = deferred();
    pending.set(orderId, kick);
    return kick.promise;
  });
  const logError = vi.fn();
  const make = () =>
    new SagaKickExecutor(
      { execute } as unknown as AdvanceCheckoutSagaUseCase,
      fakeConfigService(config),
      fakePinoLogger({ error: logError }),
    );
  return { make, execute, pending, logError };
}

describe('SagaKickExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to build without a positive concurrency', () => {
    expect(() => build({}).make()).toThrow(/Invalid config: saga\.kickConcurrency/);
    expect(() => build({ 'saga.kickConcurrency': 0 }).make()).toThrow(/Invalid config: saga\.kickConcurrency/);
  });

  it('returns before the advance it started has settled', () => {
    const { make, execute } = build();

    expect(make().submit('900001')).toBeUndefined();
    expect(execute).toHaveBeenCalledWith('900001');
  });

  it('drops a kick while every slot is busy and takes one again once a slot frees', async () => {
    const { make, execute, pending } = build();
    const executor = make();

    executor.submit('900001');
    executor.submit('900002');
    executor.submit('900003');
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['900001', '900002']);

    pending.get('900001')!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    executor.submit('900004');

    expect(execute).toHaveBeenLastCalledWith('900004');
  });

  it('logs a failed advance instead of letting it escape', async () => {
    const { make, pending, logError } = build();
    const executor = make();

    executor.submit('900001');
    pending.get('900001')!.reject(new Error('db gone'));
    await executor.drain();

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: '900001', err: expect.any(Error) as unknown }),
      expect.any(String),
    );
  });

  it('drains every kick in flight', async () => {
    const { make, pending } = build();
    const executor = make();
    executor.submit('900001');
    executor.submit('900002');
    let drained = false;

    const drain = executor.drain().then(() => (drained = true));
    pending.get('900001')!.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.get('900002')!.resolve();
    await drain;

    expect(drained).toBe(true);
  });

  describe('shutdown', () => {
    it('takes no new kick once it has begun', async () => {
      const { make, execute } = build();
      const executor = make();

      await executor.onModuleDestroy();
      executor.submit('900001');

      expect(execute).not.toHaveBeenCalled();
    });

    it('stops waiting on a kick that never settles after a bounded wait', async () => {
      vi.useFakeTimers();
      const { make } = build();
      const executor = make();
      executor.submit('900001');
      let closed = false;

      const closing = executor.onModuleDestroy().then(() => (closed = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(closed).toBe(true);
    });
  });
});
