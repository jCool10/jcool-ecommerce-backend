import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '../../../database';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../domain/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../domain/errors/reservation-timeout.error';
import type { ReservationOrderStatus } from '../domain/reservation-order-status';
import { FAKE_TX, fakeStockRepository } from '../testing/stock-port.doubles';
import type { IdGeneratorPort } from './ports/id-generator.port';
import type { StockRepositoryPort, StockTransactionOptions } from './ports/stock-repository.port';
import { InventoryParticipantService } from './inventory-participant.service';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const BUDGET_MS = 2_000;
const ORDER = '6627369374971904';
const LINES = [
  { variantId: '6627369380742144', quantity: 2 },
  { variantId: '6627369380742145', quantity: 1 },
];
const HOLD_UNTIL = new Date('2026-10-20T12:00:00.000Z');
const IDS = ['6627369380742200', '6627369380742201'];

function build(repo: Partial<StockRepositoryPort> = {}, strategy = 'pessimistic') {
  const mint = vi.fn<IdGeneratorPort['mint']>().mockResolvedValue(IDS);
  const transaction = vi.fn((work: (tx: DrizzleTx) => Promise<unknown>, _options?: StockTransactionOptions) =>
    work(FAKE_TX),
  );
  const stockRepo = fakeStockRepository({ transaction: transaction as StockRepositoryPort['transaction'], ...repo });
  const metrics = fakeMetricsPort();
  const warn = vi.fn();
  const service = new InventoryParticipantService(
    stockRepo,
    { mint },
    metrics,
    fakeConfigService({ 'inventory.lockStrategy': strategy, 'inventory.tryLockTimeoutMs': BUDGET_MS }),
    fakePinoLogger({ warn }),
  );
  return { service, stockRepo, transaction, mint, metrics, warn };
}

const header = (status: ReservationOrderStatus) => Promise.resolve({ status, holdUntil: HOLD_UNTIL });

describe('InventoryParticipantService', () => {
  useFakeClock(NOW);

  describe('tryReserve', () => {
    it('reserves with the minted ids and the hold deadline once the header is new', async () => {
      const reservePessimistic = vi.fn().mockResolvedValue(undefined);
      const insertHeader = vi.fn().mockResolvedValue(true);
      const { service, metrics } = build({ reservePessimistic, insertHeader });

      await expect(service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).resolves.toBe(
        'RESERVED',
      );

      expect(insertHeader).toHaveBeenCalledWith(FAKE_TX, { orderId: ORDER, holdUntil: HOLD_UNTIL });
      expect(reservePessimistic).toHaveBeenCalledWith(FAKE_TX, ORDER, LINES, {
        expiresAt: HOLD_UNTIL,
        reservationIds: IDS,
      });
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'reserved');
    });

    it('takes the optimistic path when configured', async () => {
      const reserveOptimistic = vi.fn().mockResolvedValue(undefined);
      const reservePessimistic = vi.fn();
      const { service } = build({ reserveOptimistic, reservePessimistic }, 'optimistic');

      await service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

      expect(reserveOptimistic).toHaveBeenCalledOnce();
      expect(reservePessimistic).not.toHaveBeenCalled();
    });

    it.each([
      [new InsufficientStockError(LINES[0].variantId, 2, 1), 'OUT_OF_STOCK', 'out_of_stock'],
      [new ReservationConflictError(LINES[0].variantId), 'CONTENDED', 'contended'],
    ] as const)('answers %s as %s', async (error, outcome, label) => {
      const { service, metrics } = build({ reservePessimistic: () => Promise.reject(error) });

      await expect(service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).resolves.toBe(outcome);
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', label);
    });

    it('logs the shortfall with SKU and quantities only', async () => {
      const { service, warn } = build({
        reservePessimistic: () => Promise.reject(new InsufficientStockError(LINES[0].variantId, 2, 1)),
      });

      await service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

      expect(warn).toHaveBeenCalledWith(
        { orderId: ORDER, variantId: LINES[0].variantId, requested: 2, available: 1 },
        expect.any(String),
      );
    });

    it('throws DB and id-service faults, counting them as errors', async () => {
      const db = build({ reservePessimistic: () => Promise.reject(new Error('connection terminated')) });
      const ids = build();
      ids.mint.mockRejectedValue(new Error('id service unavailable'));

      await expect(db.service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).rejects.toThrow(
        'connection terminated',
      );
      await expect(ids.service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).rejects.toThrow(
        'id service unavailable',
      );
      expect(db.metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'error');
      expect(ids.metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'error');
    });

    it('mints before the transaction opens, never inside it', async () => {
      const calls: string[] = [];
      const { service, mint, transaction } = build({
        insertHeader: () => {
          calls.push('insertHeader');
          return Promise.resolve(true);
        },
      });
      mint.mockImplementation(() => {
        calls.push('mint');
        return Promise.resolve(IDS);
      });
      transaction.mockImplementation((work) => {
        calls.push('transaction');
        return work(FAKE_TX);
      });

      await service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

      expect(calls).toEqual(['mint', 'transaction', 'insertHeader']);
      expect(mint).toHaveBeenCalledWith(LINES.length);
    });

    // The budget covers the whole Try, so a slow mint eats into it rather than starting it over.
    it('counts the deadline from the moment the command is entered', async () => {
      const { service, mint, transaction } = build();
      mint.mockImplementation(() => {
        vi.advanceTimersByTime(1_500);
        return Promise.resolve(IDS);
      });

      await service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { deadline: NOW.getTime() + BUDGET_MS });
    });

    it('writes nothing when the transaction only starts after the deadline', async () => {
      const insertHeader = vi.fn();
      const { service, transaction, metrics } = build({ insertHeader });
      transaction.mockImplementation((work, options) => {
        vi.setSystemTime(options!.deadline!);
        return work(FAKE_TX);
      });

      await expect(service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).rejects.toBeInstanceOf(
        ReservationTimeoutError,
      );
      expect(insertHeader).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'error');
    });

    it('answers a repeated Try on a HELD header without reserving again', async () => {
      const reservePessimistic = vi.fn();
      const { service } = build({
        insertHeader: () => Promise.resolve(false),
        findHeaderForUpdate: () => header('HELD'),
        reservePessimistic,
      });

      await expect(service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).resolves.toBe(
        'RESERVED',
      );
      expect(reservePessimistic).not.toHaveBeenCalled();
    });

    it.each(['RELEASED', 'FENCED', 'COMMITTED'] as const)('refuses a Try on a %s header', async (status) => {
      const reservePessimistic = vi.fn();
      const { service, metrics } = build({
        insertHeader: () => Promise.resolve(false),
        findHeaderForUpdate: () => header(status),
        reservePessimistic,
      });

      await expect(service.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL })).resolves.toBe(
        'CONFLICT',
      );
      expect(reservePessimistic).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'conflict');
    });
  });

  describe('commit, release and restock', () => {
    it.each([
      ['commit', 'HELD', 'commitReservations', 'COMMITTED'],
      ['release', 'HELD', 'releaseReservations', 'RELEASED'],
      ['restock', 'COMMITTED', 'restockReservations', 'RESTOCKED'],
    ] as const)('%s moves the lines and the header off %s', async (op, from, linesMethod, next) => {
      const moveLines = vi.fn().mockResolvedValue({ applied: true, alreadyResolved: false, count: 2 });
      const setHeaderStatus = vi.fn().mockResolvedValue(undefined);
      const { service, metrics } = build({
        findHeaderForUpdate: () => header(from),
        [linesMethod]: moveLines,
        setHeaderStatus,
      });

      await expect(service[op](ORDER)).resolves.toBe('APPLIED');

      expect(moveLines).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(setHeaderStatus).toHaveBeenCalledWith(FAKE_TX, ORDER, next);
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', op, 'applied');
    });

    it.each([
      ['commit', 'COMMITTED', 'IDEMPOTENT'],
      ['commit', 'RELEASED', 'CONFLICT'],
      ['release', 'FENCED', 'IDEMPOTENT'],
      ['release', 'COMMITTED', 'CONFLICT'],
      ['restock', 'RESTOCKED', 'IDEMPOTENT'],
      ['restock', 'HELD', 'CONFLICT'],
    ] as const)('%s on %s answers %s and writes nothing', async (op, status, outcome) => {
      const setHeaderStatus = vi.fn();
      const { service, stockRepo } = build({ findHeaderForUpdate: () => header(status), setHeaderStatus });
      const moves = (['commitReservations', 'releaseReservations', 'restockReservations'] as const).map((method) =>
        vi.spyOn(stockRepo, method),
      );

      await expect(service[op](ORDER)).resolves.toBe(outcome);

      expect(setHeaderStatus).not.toHaveBeenCalled();
      for (const move of moves) expect(move).not.toHaveBeenCalled();
    });

    it.each(['commit', 'release', 'restock'] as const)('%s runs under a deadline of now + budget', async (op) => {
      const { service, transaction } = build({ findHeaderForUpdate: () => header('HELD') });

      await service[op](ORDER);

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { deadline: NOW.getTime() + BUDGET_MS });
    });

    it('fences an order that has no header yet', async () => {
      const insertFencedHeader = vi.fn().mockResolvedValue(true);
      const { service, metrics } = build({ insertFencedHeader });

      await expect(service.release(ORDER)).resolves.toBe('APPLIED');

      expect(insertFencedHeader).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'release', 'applied');
    });

    // The FENCED insert waited on a Try's uncommitted header and lost once that Try committed.
    it('releases what a racing Try reserved when the fence insert loses', async () => {
      const findHeaderForUpdate = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: 'HELD', holdUntil: HOLD_UNTIL });
      const releaseReservations = vi.fn().mockResolvedValue({ applied: true, alreadyResolved: false, count: 1 });
      const setHeaderStatus = vi.fn().mockResolvedValue(undefined);
      const { service } = build({
        findHeaderForUpdate,
        insertFencedHeader: () => Promise.resolve(false),
        releaseReservations,
        setHeaderStatus,
      });

      await expect(service.release(ORDER)).resolves.toBe('APPLIED');

      expect(findHeaderForUpdate).toHaveBeenCalledTimes(2);
      expect(releaseReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(setHeaderStatus).toHaveBeenCalledWith(FAKE_TX, ORDER, 'RELEASED');
    });

    it.each(['commit', 'restock'] as const)('%s on an order with no header is a conflict', async (op) => {
      const insertFencedHeader = vi.fn();
      const { service } = build({ insertFencedHeader });

      await expect(service[op](ORDER)).resolves.toBe('CONFLICT');
      expect(insertFencedHeader).not.toHaveBeenCalled();
    });

    // A timed-out release has not happened; reporting it as APPLIED would let the saga stop compensating.
    it('throws a timed-out release instead of reporting it applied', async () => {
      const { service, metrics } = build({
        findHeaderForUpdate: () => Promise.reject(new ReservationTimeoutError()),
      });

      await expect(service.release(ORDER)).rejects.toBeInstanceOf(ReservationTimeoutError);
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'release', 'error');
    });
  });

  describe('statusOf', () => {
    it('answers every id asked for, null where there is no header', async () => {
      const findHeaderStatuses = vi.fn().mockResolvedValue(new Map([['1', 'HELD']]));
      const { service, transaction, metrics } = build({ findHeaderStatuses });

      const statuses = await service.statusOf(['1', '2']);

      expect([...statuses]).toEqual([
        ['1', 'HELD'],
        ['2', null],
      ]);
      expect(findHeaderStatuses).toHaveBeenCalledWith(['1', '2']);
      expect(transaction).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).not.toHaveBeenCalled();
    });

    it('answers an empty batch without reading', async () => {
      const findHeaderStatuses = vi.fn();
      const { service } = build({ findHeaderStatuses });

      expect((await service.statusOf([])).size).toBe(0);
      expect(findHeaderStatuses).not.toHaveBeenCalled();
    });

    it('throws a failed read', async () => {
      const { service } = build({ findHeaderStatuses: () => Promise.reject(new Error('connection terminated')) });

      await expect(service.statusOf(['1'])).rejects.toThrow('connection terminated');
    });
  });
});
