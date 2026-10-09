import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import type { SagaTransition } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import type { SagaKickExecutor } from '../saga/saga-kick.executor';
import { AuthorizationBeforePlacementError, OnPaymentAuthorizedUseCase } from './on-payment-authorized.use-case';

const ORDER_ID = '900001';
const EVENT_ID = '800001';
const TX = { tx: true } as unknown as DrizzleTx;
const AUTHORIZED = { orderId: ORDER_ID, amountMinor: 240_000, currency: 'VND' };

const order = Order.rehydrate({
  id: ORDER_ID,
  userId: 'u1',
  status: OrderStatus.PENDING,
  currency: 'VND',
  items: [OrderItem.of('sku-1', 'Widget', 120_000, 2)],
  totalAmountMinor: 240_000,
  placedAt: new Date('2026-03-01T09:00:00.000Z'),
});

const sagaAt = (step: CheckoutSaga['step'], extra: Partial<CheckoutSaga> = {}): CheckoutSaga => ({
  orderId: ORDER_ID,
  step,
  pendingCompensations: [],
  deadlineAt: new Date('2026-03-01T10:00:00.000Z'),
  nextAttemptAt: new Date('2026-03-01T10:03:00.000Z'),
  attempts: 0,
  leaseUntil: null,
  lastError: null,
  version: 4,
  ...extra,
});

function build(saga: CheckoutSaga | null, found: Order | null = order) {
  const calls: string[] = [];
  const orders = {
    findByIdForUpdate: vi.fn(() => {
      calls.push('lock order');
      return Promise.resolve(found);
    }),
  };
  const sagas = {
    findForUpdate: vi.fn(() => {
      calls.push('lock saga');
      return Promise.resolve(saga);
    }),
  };
  const writer = {
    rewrite: vi.fn(
      (_tx: DrizzleTx, current: Order, _saga: CheckoutSaga, _transition: SagaTransition, _options: unknown) =>
        Promise.resolve(current),
    ),
    reportCommitted: vi.fn(),
  };
  const kicks = { submit: vi.fn() };
  const logError = vi.fn();
  const useCase = new OnPaymentAuthorizedUseCase(
    orders as unknown as OrderRepositoryPort,
    sagas as unknown as CheckoutSagaRepositoryPort,
    writer as unknown as CheckoutSagaWriter,
    kicks as unknown as SagaKickExecutor,
    fakePinoLogger({ error: logError }),
  );
  const rewritten = (): SagaTransition | undefined => writer.rewrite.mock.calls[0]?.[3];
  return { useCase, orders, sagas, writer, kicks, logError, calls, rewritten };
}

describe('OnPaymentAuthorizedUseCase', () => {
  it('confirms a matching authorization, locking the order before the saga, and kicks only after commit', async () => {
    const { useCase, writer, kicks, calls, rewritten } = build(sagaAt(CheckoutSagaStep.AWAITING_AUTH));

    const afterCommit = await useCase.execute(AUTHORIZED, TX, EVENT_ID);

    expect(calls).toEqual(['lock order', 'lock saga']);
    expect(writer.rewrite).toHaveBeenCalledWith(
      TX,
      order,
      sagaAt(CheckoutSagaStep.AWAITING_AUTH),
      expect.objectContaining({ step: CheckoutSagaStep.COMMITTING_STOCK, wake: 'now' }),
      { now: expect.any(Date) as unknown, eventId: EVENT_ID },
    );
    expect(rewritten()?.order).toEqual({ status: OrderStatus.CONFIRMING });
    expect(kicks.submit).not.toHaveBeenCalled();

    afterCommit?.();

    expect(writer.reportCommitted).toHaveBeenCalledWith(rewritten());
    expect(kicks.submit).toHaveBeenCalledWith(ORDER_ID);
  });

  it('confirms an authorization that arrives past the deadline but inside the grace', async () => {
    const { useCase, rewritten } = build(
      sagaAt(CheckoutSagaStep.AWAITING_AUTH, { deadlineAt: new Date(Date.now() - 60_000) }),
    );

    await useCase.execute(AUTHORIZED, TX, EVENT_ID);

    expect(rewritten()?.order).toEqual({ status: OrderStatus.CONFIRMING });
  });

  it.each([
    ['amount', { amountMinor: 239_999 }],
    ['currency', { currency: 'USD' }],
  ])('fails the order and voids the money when the %s does not match the order', async (_label, mismatch) => {
    const { useCase, rewritten, logError } = build(sagaAt(CheckoutSagaStep.AWAITING_AUTH));

    await useCase.execute({ ...AUTHORIZED, ...mismatch }, TX, EVENT_ID);

    expect(rewritten()).toMatchObject({
      step: CheckoutSagaStep.COMPENSATING,
      pendingCompensations: [Compensation.RELEASE_STOCK, Compensation.CANCEL_PAYMENT],
      order: { status: OrderStatus.FAILED, reason: 'payment:amount_mismatch' },
      cause: 'amount_mismatch',
    });
    expect(logError).toHaveBeenCalled();
  });

  it.each([
    ['a compensated saga', sagaAt(CheckoutSagaStep.COMPENSATED), [Compensation.CANCEL_PAYMENT]],
    [
      'a saga already voiding',
      sagaAt(CheckoutSagaStep.COMPENSATING, { pendingCompensations: [Compensation.CANCEL_PAYMENT] }),
      [Compensation.CANCEL_PAYMENT],
    ],
    [
      'a saga still releasing stock',
      sagaAt(CheckoutSagaStep.COMPENSATING, { pendingCompensations: [Compensation.RELEASE_STOCK] }),
      [Compensation.RELEASE_STOCK, Compensation.CANCEL_PAYMENT],
    ],
  ])('voids a late authorization on %s, rewriting even when the set is unchanged', async (_label, saga, pending) => {
    const { useCase, rewritten, kicks } = build(saga);

    const afterCommit = await useCase.execute(AUTHORIZED, TX, EVENT_ID);
    afterCommit?.();

    expect(rewritten()).toMatchObject({
      step: CheckoutSagaStep.COMPENSATING,
      pendingCompensations: pending,
      order: null,
    });
    expect(kicks.submit).toHaveBeenCalledWith(ORDER_ID);
  });

  it.each([CheckoutSagaStep.COMMITTING_STOCK, CheckoutSagaStep.CAPTURING, CheckoutSagaStep.COMPLETED])(
    'acknowledges a duplicate at %s without writing anything',
    async (step) => {
      const { useCase, writer } = build(sagaAt(step));

      await expect(useCase.execute(AUTHORIZED, TX, EVENT_ID)).resolves.toBeNull();
      expect(writer.rewrite).not.toHaveBeenCalled();
    },
  );

  it('asks for a redelivery while the order is still reserving', async () => {
    const { useCase, writer } = build(sagaAt(CheckoutSagaStep.RESERVING));

    const error = await useCase.execute(AUTHORIZED, TX, EVENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationBeforePlacementError);
    expect(writer.rewrite).not.toHaveBeenCalled();
  });

  it.each([
    ['order', sagaAt(CheckoutSagaStep.AWAITING_AUTH), null],
    ['saga', null, order],
  ])('acknowledges an authorization with no %s to apply to, loudly', async (_label, saga, found) => {
    const { useCase, writer, logError } = build(saga, found);

    await expect(useCase.execute(AUTHORIZED, TX, EVENT_ID)).resolves.toBeNull();
    expect(writer.rewrite).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });
});
