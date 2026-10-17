import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { FAKE_TX, fakeStockRepository } from '../../testing/stock-port.doubles';
import { InventoryParticipantService } from './inventory-participant.service';
import type { StockRepositoryPort } from './ports/stock-repository.port';

const BUDGET_MS = 2_000;
const ORDER = 'order-1';
const LINES = [{ variantId: 'sku-a', quantity: 2 }];
const HOLD_UNTIL = new Date('2026-10-17T09:00:00Z');
const IDS = ['reservation-1'];

function headerIs(status: ReservationOrderStatus): Partial<StockRepositoryPort> {
  return {
    insertHeader: vi.fn(() => Promise.resolve(false)),
    findHeaderForUpdate: vi.fn(() => Promise.resolve({ orderId: ORDER, status, holdUntil: null })),
  };
}

function build(overrides: Partial<StockRepositoryPort> = {}, { strategy = 'pessimistic', mint = () => {} } = {}) {
  const repo = fakeStockRepository(overrides);
  const metrics = fakeMetricsPort();
  const participant = new InventoryParticipantService(
    repo,
    {
      mint: () => {
        mint();
        return Promise.resolve(IDS);
      },
    },
    fakeConfigService({ 'inventory.lockStrategy': strategy, 'inventory.tryLockTimeoutMs': BUDGET_MS }),
    metrics,
  );
  return { participant, repo, metrics };
}

const tryReserve = (participant: InventoryParticipantService) =>
  participant.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

describe('InventoryParticipantService', () => {
  describe('tryReserve', () => {
    it('holds a new order under a HELD header and stamps holdUntil on every line', async () => {
      const { participant, repo, metrics } = build();

      await expect(tryReserve(participant)).resolves.toEqual({ outcome: 'HELD' });

      expect(repo.insertHeader).toHaveBeenCalledWith(FAKE_TX, {
        orderId: ORDER,
        status: 'HELD',
        holdUntil: HOLD_UNTIL,
      });
      expect(repo.reservePessimistic).toHaveBeenCalledWith(FAKE_TX, ORDER, LINES, {
        expiresAt: HOLD_UNTIL,
        reservationIds: IDS,
      });
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'ok');
    });

    it('reserves optimistically when configured to', async () => {
      const { participant, repo } = build({}, { strategy: 'optimistic' });

      await tryReserve(participant);

      expect(repo.reserveOptimistic).toHaveBeenCalledTimes(1);
      expect(repo.reservePessimistic).not.toHaveBeenCalled();
    });

    it('answers a repeat Try from the header without holding again', async () => {
      const { participant, repo, metrics } = build(headerIs('HELD'));

      await expect(tryReserve(participant)).resolves.toEqual({ outcome: 'HELD' });

      expect(repo.reservePessimistic).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'idempotent');
    });

    it.each(['RELEASED', 'FENCED', 'COMMITTED', 'RESTOCKED'] as const)(
      'refuses a Try once the order is %s',
      async (status) => {
        const { participant, repo, metrics } = build(headerIs(status));

        await expect(tryReserve(participant)).resolves.toEqual({ outcome: 'CONFLICT' });

        expect(repo.reservePessimistic).not.toHaveBeenCalled();
        expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'conflict');
      },
    );

    it.each([
      ['a shortfall', new InsufficientStockError('sku-a', 2, 1), 'OUT_OF_STOCK'],
      ['lost CAS retries', new ReservationConflictError('sku-a'), 'CONTENDED'],
      ['a spent budget', new ReservationTimeoutError(BUDGET_MS), 'CONTENDED'],
    ] as const)('answers %s with %s', async (_, error, outcome) => {
      const { participant, metrics } = build({ reservePessimistic: () => Promise.reject(error) });

      await expect(tryReserve(participant)).resolves.toEqual({ outcome, detail: error.message });

      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'rejected');
    });

    it('rethrows an infrastructure failure', async () => {
      const failure = new Error('connection terminated');
      const { participant, metrics } = build({ reservePessimistic: () => Promise.reject(failure) });

      await expect(tryReserve(participant)).rejects.toBe(failure);

      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'error');
    });
  });

  describe('tryReserve time budget', () => {
    useFakeClock(new Date('2026-10-17T08:00:00Z'));

    it('answers CONTENDED without writing when minting ids spends the budget', async () => {
      const { participant, repo } = build({}, { mint: () => vi.advanceTimersByTime(BUDGET_MS) });

      await expect(tryReserve(participant)).resolves.toMatchObject({ outcome: 'CONTENDED' });

      expect(repo.insertHeader).not.toHaveBeenCalled();
    });

    it('answers CONTENDED without writing when the pool hands over a connection too late', async () => {
      const { participant, repo } = build({
        transaction: (work) => {
          vi.advanceTimersByTime(BUDGET_MS);
          return work(FAKE_TX);
        },
      });

      await expect(tryReserve(participant)).resolves.toMatchObject({ outcome: 'CONTENDED' });

      expect(repo.insertHeader).not.toHaveBeenCalled();
    });

    it('gives the transaction only what is left of the budget', async () => {
      const { participant, repo } = build({}, { mint: () => vi.advanceTimersByTime(300) });

      await tryReserve(participant);

      expect(repo.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: BUDGET_MS - 300 });
    });

    // Another call for this order may still commit a HELD header, so CONTENDED could be a lie.
    it('throws when the budget runs out while queued behind another call for the order', async () => {
      const { participant, metrics } = build({
        insertHeader: () => Promise.reject(new ReservationTimeoutError(BUDGET_MS)),
      });

      await expect(tryReserve(participant)).rejects.toBeInstanceOf(ReservationTimeoutError);

      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'try', 'error');
    });
  });

  describe('commit, release and restock', () => {
    it.each([
      ['commit', 'HELD', 'commitReservations', 'COMMITTED'],
      ['release', 'HELD', 'releaseReservations', 'RELEASED'],
      ['restock', 'COMMITTED', 'restockReservations', 'RESTOCKED'],
    ] as const)('%s moves the lines of a %s order', async (op, from, move, to) => {
      const { participant, repo, metrics } = build(headerIs(from));

      await expect(participant[op](ORDER)).resolves.toEqual({ outcome: to });

      expect(repo[move]).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(repo.updateHeader).toHaveBeenCalledWith(FAKE_TX, ORDER, to);
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', op, 'ok');
    });

    // Answering COMMITTED here would let the orchestrator capture for stock that was never taken.
    it.each([
      ['commit', 'HELD', 'commitReservations'],
      ['release', 'HELD', 'releaseReservations'],
      ['restock', 'COMMITTED', 'restockReservations'],
    ] as const)('throws a %s when the lines of the %s order were already moved', async (op, from, move) => {
      const { participant, repo, metrics } = build({
        ...headerIs(from),
        [move]: () => Promise.resolve({ applied: false, alreadyResolved: true, count: 0 }),
      });

      await expect(participant[op](ORDER)).rejects.toThrow(`order ${ORDER}`);

      expect(repo.updateHeader).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', op, 'error');
    });

    it.each([
      ['commit', 'COMMITTED'],
      ['release', 'RELEASED'],
      ['release', 'FENCED'],
      ['restock', 'RESTOCKED'],
    ] as const)('a repeat %s on a %s order moves nothing', async (op, status) => {
      const { participant, repo, metrics } = build(headerIs(status));

      await expect(participant[op](ORDER)).resolves.toEqual({ outcome: status });

      expect(repo.updateHeader).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', op, 'idempotent');
    });

    it.each([
      ['commit', 'RELEASED'],
      ['release', 'COMMITTED'],
      ['restock', 'HELD'],
    ] as const)('refuses a %s on a %s order', async (op, status) => {
      const { participant, repo, metrics } = build(headerIs(status));

      await expect(participant[op](ORDER)).resolves.toEqual({ outcome: 'CONFLICT' });

      expect(repo.commitReservations).not.toHaveBeenCalled();
      expect(repo.releaseReservations).not.toHaveBeenCalled();
      expect(repo.restockReservations).not.toHaveBeenCalled();
      expect(repo.updateHeader).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', op, 'conflict');
    });

    it.each(['commit', 'restock'] as const)('refuses a %s on an order that was never tried', async (op) => {
      const { participant, repo } = build();

      await expect(participant[op](ORDER)).resolves.toEqual({ outcome: 'CONFLICT' });

      expect(repo.insertHeader).not.toHaveBeenCalled();
    });

    it('fences an order released before any Try reached it', async () => {
      const { participant, repo, metrics } = build();

      await expect(participant.release(ORDER)).resolves.toEqual({ outcome: 'FENCED' });

      expect(repo.insertHeader).toHaveBeenCalledWith(FAKE_TX, { orderId: ORDER, status: 'FENCED', holdUntil: null });
      expect(repo.releaseReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'release', 'fenced');
    });

    it('releases a Try that committed its header while the fence insert waited on it', async () => {
      const { participant, repo } = build({
        insertHeader: () => Promise.resolve(false),
        findHeaderForUpdate: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ orderId: ORDER, status: 'HELD', holdUntil: HOLD_UNTIL }),
      });

      await expect(participant.release(ORDER)).resolves.toEqual({ outcome: 'RELEASED' });

      expect(repo.releaseReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(repo.updateHeader).toHaveBeenCalledWith(FAKE_TX, ORDER, 'RELEASED');
    });

    it.each(['commit', 'release', 'restock'] as const)('bounds a %s by the Try budget', async (op) => {
      const { participant, repo } = build(headerIs('HELD'));

      await participant[op](ORDER);

      expect(repo.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: BUDGET_MS });
    });

    // Reading a timeout as FENCED would let the orchestrator drop a hold that is still there.
    it('throws a release that timed out instead of answering FENCED', async () => {
      const { participant, metrics } = build({
        findHeaderForUpdate: () => Promise.reject(new ReservationTimeoutError(BUDGET_MS)),
      });

      await expect(participant.release(ORDER)).rejects.toBeInstanceOf(ReservationTimeoutError);

      expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'release', 'error');
    });
  });
});
