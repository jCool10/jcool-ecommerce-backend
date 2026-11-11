import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import type { OrderInventoryParticipantPort, StockHoldStatus } from '../ports/order-inventory-participant.port';
import type { OrderPaymentParticipantPort, OrderPaymentStatus } from '../ports/order-payment-participant.port';
import type { OrderRepositoryPort, OrderStatusStamp, SettledSagaOrder } from '../ports/order-repository.port';
import { RunCheckoutInvariantsUseCase } from './run-checkout-invariants.use-case';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const SETTINGS = { settleSec: 600, windowSec: 86_400, batchSize: 2, notBefore: null as Date | null };

const NO_VIOLATIONS = {
  captured_without_paid: 0,
  paid_without_capture: 0,
  paid_without_commit: 0,
  orphan_hold: 0,
  authorized_on_dead_order: 0,
  refunded_without_refund: 0,
  refunded_without_restock: 0,
};

const CAPTURED: OrderPaymentStatus = {
  header: 'CAPTURED',
  authorizedPaymentId: 'pay-1',
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: true,
};
const CLOSED: OrderPaymentStatus = {
  header: 'CANCELLED',
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
};

const settled = (id: string, status: SettledSagaOrder['status'], minute: number): SettledSagaOrder => ({
  id,
  status,
  finalizedAt: new Date(Date.UTC(2026, 9, 24, 9, minute)),
  updatedAt: new Date(Date.UTC(2026, 9, 24, 9, minute)),
});

interface Fixture {
  pages: SettledSagaOrder[][];
  running?: string[];
  stock?: Record<string, StockHoldStatus | null>;
  payment?: Record<string, OrderPaymentStatus>;
  /** What the re-read after the participants finds; by default each order as its page read it. */
  reread?: Record<string, OrderStatusStamp | null>;
  settings?: Partial<typeof SETTINGS>;
}

function build({ pages, running = [], stock = {}, payment = {}, reread = {}, settings = {} }: Fixture) {
  const findTerminalSagaOrdersInWindow = vi.fn<OrderRepositoryPort['findTerminalSagaOrdersInWindow']>();
  for (const page of pages) findTerminalSagaOrdersInWindow.mockResolvedValueOnce(page);
  findTerminalSagaOrdersInWindow.mockResolvedValue([]);
  const asRead = new Map(pages.flat().map(({ id, status, updatedAt }) => [id, { status, updatedAt }]));
  const findStatusesByIds = vi.fn<OrderRepositoryPort['findStatusesByIds']>((ids) =>
    Promise.resolve(
      new Map(
        ids.flatMap((id): [string, OrderStatusStamp][] => {
          const stamp = id in reread ? reread[id] : asRead.get(id);
          return stamp ? [[id, stamp]] : [];
        }),
      ),
    ),
  );

  const runningOrderIds = vi.fn<CheckoutSagaEnginePort['runningOrderIds']>((ids) =>
    Promise.resolve(new Set(ids.filter((id) => running.includes(id)))),
  );
  const answer =
    <T>(byId: Record<string, T>, fallback: T) =>
    (ids: string[]) =>
      Promise.resolve(new Map(ids.map((id): [string, T] => [id, byId[id] ?? fallback])));
  const inventory = { statusOf: vi.fn<OrderInventoryParticipantPort['statusOf']>(answer(stock, 'RELEASED')) };
  const paymentPort = { statusOf: vi.fn<OrderPaymentParticipantPort['statusOf']>(answer(payment, CLOSED)) };
  const metrics = fakeMetricsPort();
  const logger = { error: vi.fn(), warn: vi.fn() };

  const useCase = new RunCheckoutInvariantsUseCase(
    { findTerminalSagaOrdersInWindow, findStatusesByIds } as unknown as OrderRepositoryPort,
    { runningOrderIds } as unknown as CheckoutSagaEnginePort,
    inventory as unknown as OrderInventoryParticipantPort,
    paymentPort as unknown as OrderPaymentParticipantPort,
    metrics,
    fakeConfigService({ checkoutSaga: { invariant: { ...SETTINGS, ...settings } } }),
    fakePinoLogger(logger),
  );
  return {
    useCase,
    findTerminalSagaOrdersInWindow,
    findStatusesByIds,
    runningOrderIds,
    inventory,
    payment: paymentPort,
    metrics,
    logger,
  };
}

describe('RunCheckoutInvariantsUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans the window between the settle delay and its width', async () => {
    const { useCase, findTerminalSagaOrdersInWindow } = build({ pages: [] });

    await useCase.execute();

    expect(findTerminalSagaOrdersInWindow).toHaveBeenCalledExactlyOnceWith(
      { from: new Date('2026-10-23T10:00:00.000Z'), to: new Date('2026-10-24T09:50:00.000Z') },
      null,
      2,
    );
  });

  it.each([
    ['a cut-off inside the window raises the lower bound', '2026-10-24T08:00:00.000Z', '2026-10-24T08:00:00.000Z'],
    ['a cut-off before the window leaves it', '2026-10-01T00:00:00.000Z', '2026-10-23T10:00:00.000Z'],
  ])('%s', async (_case, notBefore, from) => {
    const { useCase, findTerminalSagaOrdersInWindow } = build({
      pages: [],
      settings: { notBefore: new Date(notBefore) },
    });

    await useCase.execute();

    expect(findTerminalSagaOrdersInWindow.mock.calls[0][0].from).toEqual(new Date(from));
  });

  it('pages on from the last row read, even one it then left out as still running', async () => {
    const first = [settled('1', OrderStatus.PAID, 1), settled('2', OrderStatus.EXPIRED, 2)];
    const second = [settled('3', OrderStatus.CANCELLED, 3)];
    const { useCase, findTerminalSagaOrdersInWindow } = build({
      pages: [first, second],
      running: ['2'],
      stock: { '1': 'COMMITTED' },
      payment: { '1': CAPTURED },
    });

    const run = await useCase.execute();

    expect(findTerminalSagaOrdersInWindow.mock.calls.map(([, after]) => after)).toEqual([
      null,
      { id: '2', finalizedAt: first[1].finalizedAt },
    ]);
    expect(run).toMatchObject({ result: 'ok', checked: 2 });
  });

  it('stops after a short page without asking for another', async () => {
    const { useCase, findTerminalSagaOrdersInWindow } = build({ pages: [[settled('1', OrderStatus.EXPIRED, 1)]] });

    await useCase.execute();

    expect(findTerminalSagaOrdersInWindow).toHaveBeenCalledOnce();
  });

  it('leaves orders whose saga is still running to the saga, unasked and uncounted', async () => {
    const { useCase, inventory, payment, metrics } = build({
      pages: [[settled('1', OrderStatus.EXPIRED, 1), settled('2', OrderStatus.CANCELLED, 2)]],
      running: ['2'],
      stock: { '2': 'HELD' },
    });

    await useCase.execute();

    expect(inventory.statusOf).toHaveBeenCalledExactlyOnceWith(['1']);
    expect(payment.statusOf).toHaveBeenCalledExactlyOnceWith(['1']);
    expect(metrics.setCheckoutInvariantViolations).toHaveBeenCalledExactlyOnceWith(NO_VIOLATIONS);
  });

  it('asks no participant when the whole page is still running', async () => {
    const { useCase, inventory, payment } = build({
      pages: [[settled('1', OrderStatus.EXPIRED, 1)]],
      running: ['1'],
    });

    await useCase.execute();

    expect(inventory.statusOf).not.toHaveBeenCalled();
    expect(payment.statusOf).not.toHaveBeenCalled();
  });

  it('counts violations across pages, writes every kind, and logs each order that broke one', async () => {
    const { useCase, metrics, logger } = build({
      pages: [
        [settled('1', OrderStatus.EXPIRED, 1), settled('2', OrderStatus.CANCELLED, 2)],
        [settled('3', OrderStatus.PAID, 3)],
      ],
      stock: { '1': 'HELD', '2': 'HELD', '3': 'COMMITTED' },
      payment: { '3': CLOSED },
    });

    const run = await useCase.execute();

    const violations = { ...NO_VIOLATIONS, orphan_hold: 2, paid_without_capture: 1 };
    expect(run).toEqual({ result: 'violations', checked: 3, violations });
    expect(metrics.setCheckoutInvariantViolations).toHaveBeenCalledExactlyOnceWith(violations);
    expect(metrics.recordInvariantCheck).toHaveBeenCalledExactlyOnceWith('violations');
    expect(logger.error.mock.calls.map(([fields]) => fields as unknown)).toEqual([
      expect.objectContaining({ orderId: '1', kind: 'orphan_hold' }),
      expect.objectContaining({ orderId: '2', kind: 'orphan_hold' }),
      expect.objectContaining({ orderId: '3', kind: 'paid_without_capture' }),
    ]);
  });

  describe('an order that moved while it was being judged', () => {
    const REFUNDING_HEADER: OrderPaymentStatus = { ...CAPTURED, header: 'REFUNDING' };

    it('re-reads the judged orders only after both participants answered', async () => {
      const { useCase, findStatusesByIds, inventory, payment } = build({
        pages: [[settled('1', OrderStatus.EXPIRED, 1), settled('2', OrderStatus.CANCELLED, 2)]],
        running: ['2'],
      });

      await useCase.execute();

      expect(findStatusesByIds).toHaveBeenCalledExactlyOnceWith(['1']);
      const [reread] = findStatusesByIds.mock.invocationCallOrder;
      expect(reread).toBeGreaterThan(inventory.statusOf.mock.invocationCallOrder[0]);
      expect(reread).toBeGreaterThan(payment.statusOf.mock.invocationCallOrder[0]);
    });

    it('skips an order whose status changed between the batch and the re-read', async () => {
      const order = settled('1', OrderStatus.PAID, 1);
      const { useCase, metrics, logger } = build({
        pages: [[order]],
        stock: { '1': 'COMMITTED' },
        payment: { '1': REFUNDING_HEADER },
        reread: { '1': { status: OrderStatus.REFUNDING, updatedAt: new Date(NOW) } },
      });

      await expect(useCase.execute()).resolves.toEqual({ result: 'ok', checked: 0, violations: NO_VIOLATIONS });
      expect(metrics.setCheckoutInvariantViolations).toHaveBeenCalledExactlyOnceWith(NO_VIOLATIONS);
      expect(logger.error).not.toHaveBeenCalled();
    });

    // PAID, then REFUNDING while the participants were read, then PAID again after a failed refund.
    it('skips an order that left and came back to the same status, by its updated_at', async () => {
      const order = settled('1', OrderStatus.PAID, 1);
      const { useCase, logger } = build({
        pages: [[order]],
        stock: { '1': 'COMMITTED' },
        payment: { '1': REFUNDING_HEADER },
        reread: { '1': { status: OrderStatus.PAID, updatedAt: new Date(NOW) } },
      });

      await expect(useCase.execute()).resolves.toMatchObject({ result: 'ok', checked: 0 });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips an order that is gone by the re-read', async () => {
      const { useCase } = build({
        pages: [[settled('1', OrderStatus.EXPIRED, 1)]],
        stock: { '1': 'HELD' },
        reread: { '1': null },
      });

      await expect(useCase.execute()).resolves.toMatchObject({ result: 'ok', checked: 0 });
    });

    it('judges an order whose status and updated_at both held', async () => {
      const order = settled('1', OrderStatus.PAID, 1);
      const { useCase } = build({
        pages: [[order]],
        stock: { '1': 'COMMITTED' },
        payment: { '1': REFUNDING_HEADER },
        reread: { '1': { status: OrderStatus.PAID, updatedAt: new Date(order.updatedAt) } },
      });

      await expect(useCase.execute()).resolves.toEqual({
        result: 'violations',
        checked: 1,
        violations: { ...NO_VIOLATIONS, paid_without_capture: 1 },
      });
    });
  });

  it('judges a refunded order against its refund and its restock', async () => {
    const { useCase } = build({
      pages: [[settled('1', OrderStatus.REFUNDED, 1), settled('2', OrderStatus.REFUNDED, 2)]],
      stock: { '1': 'RESTOCKED', '2': 'COMMITTED' },
      payment: { '1': { ...CAPTURED, header: 'REFUNDED' }, '2': { ...CAPTURED, header: 'REFUND_FAILED' } },
    });

    await expect(useCase.execute()).resolves.toEqual({
      result: 'violations',
      checked: 2,
      violations: { ...NO_VIOLATIONS, refunded_without_refund: 1, refunded_without_restock: 1 },
    });
  });

  it('records a clean run with every kind at zero', async () => {
    const { useCase, metrics } = build({ pages: [] });

    await expect(useCase.execute()).resolves.toEqual({ result: 'ok', checked: 0, violations: NO_VIOLATIONS });
    expect(metrics.setCheckoutInvariantViolations).toHaveBeenCalledExactlyOnceWith(NO_VIOLATIONS);
    expect(metrics.recordInvariantCheck).toHaveBeenCalledExactlyOnceWith('ok');
  });

  it.each([
    ['visibility', 'runningOrderIds'],
    ['stock', 'inventory'],
    ['payment', 'payment'],
    ['the re-read', 'findStatusesByIds'],
  ] as const)('keeps the last gauges when %s cannot answer', async (_name, failing) => {
    const built = build({ pages: [[settled('1', OrderStatus.EXPIRED, 1)]] });
    const fault = new Error('unreachable');
    if (failing === 'runningOrderIds' || failing === 'findStatusesByIds') built[failing].mockRejectedValue(fault);
    else built[failing].statusOf.mockRejectedValue(fault);

    await expect(built.useCase.execute()).resolves.toMatchObject({ result: 'error' });
    expect(built.metrics.recordInvariantCheck).toHaveBeenCalledExactlyOnceWith('error');
    expect(built.metrics.setCheckoutInvariantViolations).not.toHaveBeenCalled();
    expect(built.logger.warn).toHaveBeenCalledOnce();
  });
});
