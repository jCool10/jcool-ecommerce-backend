import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { IdGeneratorPort } from '@shared/identity/id-generator.port';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { FAKE_TX, fakeStockRepository } from '../../testing/stock-port.doubles';
import { InventoryParticipantService } from './inventory-participant.service';
import type { ReservationOrderHeader, StockRepositoryPort } from './ports/stock-repository.port';

const ORDER = 'order-1';
const LINES = [{ variantId: 'sku-a', quantity: 2 }];
const NOW = new Date('2026-10-05T09:00:00Z');
const HOLD_UNTIL = new Date('2026-10-05T10:00:00Z');
const TRY_TIMEOUT_MS = 1500;
const RESERVATION_IDS = ['res-1', 'res-2', 'res-3'];

const spend = (ms: number) => vi.setSystemTime(Date.now() + ms);

interface BuildOptions {
  strategy?: string;
  status?: ReservationOrderStatus;
  overrides?: Partial<StockRepositoryPort>;
}

function build({ strategy, status, overrides = {} }: BuildOptions = {}) {
  const headers = new Map<string, ReservationOrderHeader>();
  if (status) headers.set(ORDER, { orderId: ORDER, status, holdUntil: HOLD_UNTIL });
  const stock = fakeStockRepository(overrides, headers);
  const spies = {
    transaction: vi.spyOn(stock, 'transaction'),
    insertHeader: vi.spyOn(stock, 'insertHeader'),
    reservePessimistic: vi.spyOn(stock, 'reservePessimistic'),
    reserveOptimistic: vi.spyOn(stock, 'reserveOptimistic'),
    commitReservations: vi.spyOn(stock, 'commitReservations'),
    releaseReservations: vi.spyOn(stock, 'releaseReservations'),
    restockReservations: vi.spyOn(stock, 'restockReservations'),
  };
  const metrics = fakeMetricsPort();
  const mint = vi.fn<IdGeneratorPort['mint']>((count = 1) => Promise.resolve(RESERVATION_IDS.slice(0, count)));
  const participant = new InventoryParticipantService(
    stock,
    { mint },
    fakeConfigService({ 'inventory.lockStrategy': strategy, 'inventory.tryLockTimeoutMs': TRY_TIMEOUT_MS }),
    metrics,
  );
  const statusOf = () => headers.get(ORDER)?.status;
  return { participant, spies, metrics, headers, statusOf, mint };
}

const HOLD = { expiresAt: HOLD_UNTIL, reservationIds: ['res-1'] };

const tryReserve = (participant: InventoryParticipantService) =>
  participant.tryReserve({ orderId: ORDER, lines: LINES, holdUntil: HOLD_UNTIL });

describe('InventoryParticipantService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to build without a try timeout', () => {
    expect(
      () =>
        new InventoryParticipantService(
          fakeStockRepository(),
          { mint: () => Promise.resolve([]) },
          fakeConfigService({}),
          fakeMetricsPort(),
        ),
    ).toThrow(/inventory\.tryLockTimeoutMs/);
  });

  describe('tryReserve', () => {
    it('fences the order, then holds its lines until the deadline the orchestrator passed', async () => {
      const { participant, spies, metrics, headers } = build();

      expect(await tryReserve(participant)).toEqual({ outcome: 'HELD' });

      expect(headers.get(ORDER)).toEqual({ orderId: ORDER, status: 'HELD', holdUntil: HOLD_UNTIL });
      expect(spies.reservePessimistic).toHaveBeenCalledWith(FAKE_TX, ORDER, LINES, HOLD);
      expect(spies.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: TRY_TIMEOUT_MS });
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'ok');
    });

    it('mints reservation ids before the transaction opens', async () => {
      const { participant, spies, mint } = build();

      await tryReserve(participant);

      expect(mint).toHaveBeenCalledWith(LINES.length);
      expect(mint.mock.invocationCallOrder[0]).toBeLessThan(spies.transaction.mock.invocationCallOrder[0]);
    });

    it('holds through the optimistic path when configured', async () => {
      const { participant, spies } = build({ strategy: 'optimistic' });

      await tryReserve(participant);

      expect(spies.reserveOptimistic).toHaveBeenCalledWith(FAKE_TX, ORDER, LINES, HOLD);
      expect(spies.reservePessimistic).not.toHaveBeenCalled();
    });

    it('answers a repeat with HELD and holds nothing more', async () => {
      const { participant, spies, metrics } = build({ status: 'HELD' });

      expect(await tryReserve(participant)).toEqual({ outcome: 'HELD' });

      expect(spies.reservePessimistic).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'idempotent');
    });

    it.each<ReservationOrderStatus>(['RELEASED', 'FENCED', 'COMMITTED', 'RESTOCKED'])(
      'refuses to hold an order already %s',
      async (status) => {
        const { participant, spies, metrics, statusOf } = build({ status });

        expect(await tryReserve(participant)).toEqual({ outcome: 'CONFLICT' });

        expect(spies.reservePessimistic).not.toHaveBeenCalled();
        expect(statusOf()).toBe(status);
        expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'conflict');
      },
    );

    it.each([
      ['OUT_OF_STOCK', 'a shortfall', new InsufficientStockError('sku-a', 2, 1)],
      ['CONTENDED', 'a spent retry budget', new ReservationConflictError('sku-a')],
      ['CONTENDED', 'a lock wait past the timeout', new ReservationTimeoutError(TRY_TIMEOUT_MS)],
    ])('answers %s for %s instead of throwing', async (outcome, _cause, error) => {
      const { participant, metrics } = build({
        overrides: { reservePessimistic: () => Promise.reject(error) },
      });

      expect(await tryReserve(participant)).toEqual({ outcome, detail: error.message });
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'rejected');
    });

    it('rethrows an infrastructure fault', async () => {
      const fault = new Error('connection terminated');
      const { participant, metrics } = build({ overrides: { insertHeader: () => Promise.reject(fault) } });

      await expect(tryReserve(participant)).rejects.toBe(fault);
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'error');
    });

    it.each<[string, Partial<StockRepositoryPort>]>([
      ['inserting', { insertHeader: () => Promise.reject(new ReservationTimeoutError(TRY_TIMEOUT_MS)) }],
      [
        'locking',
        {
          insertHeader: () => Promise.resolve(false),
          findHeaderForUpdate: () => Promise.reject(new ReservationTimeoutError(TRY_TIMEOUT_MS)),
        },
      ],
    ])('rethrows a timeout while %s its own header instead of answering CONTENDED', async (_step, overrides) => {
      const { participant, spies, metrics } = build({ overrides });

      await expect(tryReserve(participant)).rejects.toBeInstanceOf(ReservationTimeoutError);
      expect(spies.reservePessimistic).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'error');
    });

    it('fails loudly when it lost the header insert yet finds no header', async () => {
      const { participant } = build({
        overrides: { insertHeader: () => Promise.resolve(false), findHeaderForUpdate: () => Promise.resolve(null) },
      });

      await expect(tryReserve(participant)).rejects.toThrow(/order-1/);
    });

    it('gives its transaction only what minting left of the budget', async () => {
      const { participant, spies, mint } = build();
      mint.mockImplementationOnce((count = 1) => {
        spend(400);
        return Promise.resolve(RESERVATION_IDS.slice(0, count));
      });

      await tryReserve(participant);

      expect(spies.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: TRY_TIMEOUT_MS - 400 });
    });

    it.each<[string, (ctx: ReturnType<typeof build>) => void]>([
      [
        'minting ids',
        ({ mint }) =>
          mint.mockImplementationOnce((count = 1) => {
            spend(TRY_TIMEOUT_MS);
            return Promise.resolve(RESERVATION_IDS.slice(0, count));
          }),
      ],
      [
        'waiting for a pooled connection',
        ({ spies }) =>
          spies.transaction.mockImplementationOnce((work) => {
            spend(TRY_TIMEOUT_MS);
            return work(FAKE_TX);
          }),
      ],
    ])('answers CONTENDED without touching the header once %s spent the budget', async (_step, stall) => {
      const ctx = build();
      stall(ctx);

      expect(await tryReserve(ctx.participant)).toMatchObject({ outcome: 'CONTENDED' });

      expect(ctx.spies.insertHeader).not.toHaveBeenCalled();
      expect(ctx.headers.size).toBe(0);
      expect(ctx.metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'try', 'rejected');
    });
  });

  it.each<[string, ReservationOrderStatus | undefined]>([
    ['commit', 'HELD'],
    ['release', undefined],
    ['restock', 'COMMITTED'],
  ])('bounds the %s transaction by the same budget', async (op, status) => {
    const { participant, spies } = build({ status });

    await participant[op as 'commit' | 'release' | 'restock'](ORDER);

    expect(spies.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: TRY_TIMEOUT_MS });
  });

  it('rethrows a release that timed out queued on the header instead of answering FENCED', async () => {
    const { participant, metrics, headers } = build({
      overrides: { insertHeader: () => Promise.reject(new ReservationTimeoutError(TRY_TIMEOUT_MS)) },
    });

    await expect(participant.release(ORDER)).rejects.toBeInstanceOf(ReservationTimeoutError);

    expect(headers.size).toBe(0);
    expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'release', 'error');
  });

  describe('commit', () => {
    it('commits the held lines and the header together', async () => {
      const { participant, spies, metrics, statusOf } = build({ status: 'HELD' });

      expect(await participant.commit(ORDER)).toEqual({ outcome: 'COMMITTED' });

      expect(spies.commitReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(statusOf()).toBe('COMMITTED');
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'commit', 'ok');
    });

    it('answers a repeat without moving stock again', async () => {
      const { participant, spies, metrics } = build({ status: 'COMMITTED' });

      expect(await participant.commit(ORDER)).toEqual({ outcome: 'COMMITTED' });

      expect(spies.commitReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'commit', 'idempotent');
    });

    it('refuses an order that was never held', async () => {
      const { participant, spies, metrics, headers } = build();

      expect(await participant.commit(ORDER)).toEqual({ outcome: 'CONFLICT' });

      expect(spies.commitReservations).not.toHaveBeenCalled();
      expect(headers.size).toBe(0);
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'commit', 'conflict');
    });
  });

  describe('release', () => {
    it('releases the held lines and the header together', async () => {
      const { participant, spies, metrics, statusOf } = build({ status: 'HELD' });

      expect(await participant.release(ORDER)).toEqual({ outcome: 'RELEASED' });

      expect(spies.releaseReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(statusOf()).toBe('RELEASED');
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'release', 'ok');
    });

    it('fences an order no Try has reached yet, touching no stock', async () => {
      const { participant, spies, metrics, headers } = build();

      expect(await participant.release(ORDER)).toEqual({ outcome: 'FENCED' });

      expect(headers.get(ORDER)).toEqual({ orderId: ORDER, status: 'FENCED', holdUntil: null });
      expect(spies.releaseReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'release', 'fenced');
    });

    it('releases what a racing Try held when the fence insert loses to it', async () => {
      const headers = new Map<string, ReservationOrderHeader>();
      let reads = 0;
      const { participant, spies } = build({
        overrides: {
          findHeaderForUpdate: () =>
            Promise.resolve(reads++ === 0 ? null : { orderId: ORDER, status: 'HELD', holdUntil: HOLD_UNTIL }),
          insertHeader: () => Promise.resolve(false),
          updateHeader: (_tx, orderId, status) => {
            headers.set(orderId, { orderId, status, holdUntil: HOLD_UNTIL });
            return Promise.resolve();
          },
        },
      });

      expect(await participant.release(ORDER)).toEqual({ outcome: 'RELEASED' });

      expect(spies.releaseReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(headers.get(ORDER)?.status).toBe('RELEASED');
    });

    it.each<ReservationOrderStatus>(['RELEASED', 'FENCED'])('answers a repeat on %s', async (status) => {
      const { participant, spies, metrics } = build({ status });

      expect(await participant.release(ORDER)).toEqual({ outcome: status });

      expect(spies.releaseReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'release', 'idempotent');
    });

    it('refuses a committed order, which only restock can undo', async () => {
      const { participant, spies, statusOf } = build({ status: 'COMMITTED' });

      expect(await participant.release(ORDER)).toEqual({ outcome: 'CONFLICT' });

      expect(spies.releaseReservations).not.toHaveBeenCalled();
      expect(statusOf()).toBe('COMMITTED');
    });
  });

  describe('restock', () => {
    it('puts committed lines back on hand', async () => {
      const { participant, spies, metrics, statusOf } = build({ status: 'COMMITTED' });

      expect(await participant.restock(ORDER)).toEqual({ outcome: 'RESTOCKED' });

      expect(spies.restockReservations).toHaveBeenCalledWith(FAKE_TX, ORDER);
      expect(statusOf()).toBe('RESTOCKED');
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'restock', 'ok');
    });

    it('answers a repeat without putting stock back twice', async () => {
      const { participant, spies, metrics } = build({ status: 'RESTOCKED' });

      expect(await participant.restock(ORDER)).toEqual({ outcome: 'RESTOCKED' });

      expect(spies.restockReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'restock', 'idempotent');
    });

    it('refuses an order that is still only held', async () => {
      const { participant, spies, metrics } = build({ status: 'HELD' });

      expect(await participant.restock(ORDER)).toEqual({ outcome: 'CONFLICT' });

      expect(spies.restockReservations).not.toHaveBeenCalled();
      expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', 'restock', 'conflict');
    });
  });

  it.each(['commit', 'release', 'restock'] as const)('rethrows a fault from %s and counts it', async (op) => {
    const fault = new Error('deadlock detected');
    const { participant, metrics } = build({
      status: op === 'restock' ? 'COMMITTED' : 'HELD',
      overrides: { updateHeader: () => Promise.reject(fault) },
    });

    await expect(participant[op](ORDER)).rejects.toBe(fault);
    expect(metrics.recordTccBranch).toHaveBeenCalledExactlyOnceWith('inventory', op, 'error');
  });
});
