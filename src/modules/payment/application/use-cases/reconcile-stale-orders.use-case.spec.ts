import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizeOrderUseCase, FinalizeResult } from '@modules/order/application/public/order-finalization.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import type { OrderReadPort, StalePendingOrderView } from '../ports/order-read.port';
import type { ExpireSessionOutcome, GatewayStatus, PaymentGatewayPort } from '../ports/payment-gateway.port';
import type { PaymentRepositoryPort } from '../ports/payment-repository.port';
import { ReconcileStaleOrdersUseCase } from './reconcile-stale-orders.use-case';

const INPUT = { staleAfterSec: 120, ttlSec: 900, batchSize: 50 };
const NOW = new Date('2026-08-21T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 5 * 60_000); // stale enough to sweep, well inside the TTL
const LAPSED = new Date(NOW.getTime() - 20 * 60_000); // past the TTL, not yet long enough to alert
const ANCIENT = new Date(NOW.getTime() - 60 * 60_000); // far past the TTL

const EMPTY_SUMMARY = {
  scanned: 0,
  finalized: 0,
  stillPending: 0,
  alreadySettled: 0,
  raced: 0,
  unresolved: 0,
  errors: 0,
};

function orderId(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`;
}

// What a gateway reports for a session opened for `pendingPayment`: the same money, in the
// lowercase the providers send.
const MATCHING_CHARGE = { amountMinor: 150_000, currency: 'vnd' };

function pendingPayment(
  id: string,
  order: string,
  status: PaymentStatus = PaymentStatus.PENDING,
  providerIntentId: string | null = 'pi_known',
): Payment {
  return Payment.rehydrate({
    id,
    orderId: order,
    provider: 'stripe',
    providerSessionId: `cs_${order}`,
    providerIntentId,
    amountMinor: 150_000,
    currency: 'VND',
    status,
  });
}

interface Scenario {
  stale?: StalePendingOrderView[];
  payments?: Record<string, Payment | null>;
  gateway?: Record<string, GatewayStatus>;
  gatewayIntents?: Record<string, string>;
  /** Per-session charge the gateway reports; unlisted sessions report the payment's own money. */
  gatewayCharges?: Record<string, { amountMinor?: number; currency?: string }>;
  gatewayThrows?: string[];
  expireThrows?: string[];
  /** Per-session refusal outcome; anything unlisted expires cleanly. */
  expireReturns?: Record<string, ExpireSessionOutcome>;
  /** null models the compare-and-set losing to a webhook that settled the payment mid-sweep. */
  updateStatusReturns?: Payment | null;
  finalize?: FinalizeResult['status'];
}

function build(scenario: Scenario = {}) {
  const findStalePending = vi.fn().mockResolvedValue(scenario.stale ?? []);
  const findByOrderId = vi.fn((id: string) => Promise.resolve(scenario.payments?.[id] ?? null));
  const updateStatus = vi.fn(() =>
    Promise.resolve(
      scenario.updateStatusReturns === undefined ? pendingPayment('pw', 'o') : scenario.updateStatusReturns,
    ),
  );
  const getPaymentStatus = vi.fn((ref: string) => {
    if (scenario.gatewayThrows?.includes(ref)) return Promise.reject(new Error('gateway unreachable'));
    return Promise.resolve({
      status: scenario.gateway?.[ref] ?? 'UNKNOWN',
      intentId: scenario.gatewayIntents?.[ref],
      ...(scenario.gatewayCharges?.[ref] ?? MATCHING_CHARGE),
    });
  });
  const expireSession = vi.fn((ref: string) => {
    if (scenario.expireThrows?.includes(ref)) return Promise.reject(new Error('session not expirable'));
    return Promise.resolve(scenario.expireReturns?.[ref] ?? 'expired');
  });
  const finalizeExec = vi.fn().mockResolvedValue({ status: scenario.finalize ?? 'finalized' });
  const warn = vi.fn();
  const info = vi.fn();
  const error = vi.fn();

  const useCase = new ReconcileStaleOrdersUseCase(
    { findStalePending } as unknown as OrderReadPort,
    { findByOrderId, updateStatus } as unknown as PaymentRepositoryPort,
    { getPaymentStatus, expireSession } as unknown as PaymentGatewayPort,
    { execute: finalizeExec } as unknown as FinalizeOrderUseCase,
    { warn, info, error } as unknown as PinoLogger,
  );
  return {
    useCase,
    spies: {
      findStalePending,
      findByOrderId,
      updateStatus,
      getPaymentStatus,
      expireSession,
      finalizeExec,
      warn,
      info,
      error,
    },
  };
}

describe('ReconcileStaleOrdersUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  it('only asks for orders older than the stale threshold, capped at the batch size', async () => {
    const { useCase, spies } = build();

    await useCase.execute(INPUT);

    expect(spies.findStalePending).toHaveBeenCalledWith({
      placedBefore: new Date(NOW.getTime() - 120_000),
      limit: 50,
    });
  });

  it('settles payment then order when the gateway reports PAID (the lost-webhook case)', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p1', id) },
      gateway: { [`cs_${id}`]: 'PAID' },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).toHaveBeenCalledWith('p1', PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith({
      orderId: id,
      outcome: 'PAID',
      paymentRef: 'pi_known',
      reason: 'reconcile:paid',
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, finalized: 1 });
  });

  it('records the transaction handle the missing webhook never delivered', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p1', id, PaymentStatus.PENDING, null) },
      gateway: { [`cs_${id}`]: 'PAID' },
      gatewayIntents: { [`cs_${id}`]: 'pi_from_gateway' },
    });

    await useCase.execute(INPUT);

    expect(spies.updateStatus).toHaveBeenCalledWith('p1', PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.PENDING,
      providerIntentId: 'pi_from_gateway',
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: 'pi_from_gateway' }));
  });

  // The refusal the webhook path already makes: a PAID session holding different money is not the
  // one this payment was for, so settling it would pay an order out of someone else's charge.
  it.each([
    ['a different amount', { amountMinor: 149_000, currency: 'vnd' }],
    ['a different currency', { amountMinor: 150_000, currency: 'usd' }],
    ['no charge at all', {}],
  ])('refuses to settle a paid session reporting %s', async (_case, charge) => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p1', id) },
      gateway: { [`cs_${id}`]: 'PAID' },
      gatewayCharges: { [`cs_${id}`]: charge },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: id, paymentId: 'p1' }),
      expect.stringContaining('does not match the recorded payment'),
    );
    // Still inside the stuck window: the refusal is real, the alarm is not yet due.
    expect(spies.error).not.toHaveBeenCalledWith(expect.objectContaining({ stuck: true }), expect.any(String));
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, unresolved: 1 });
  });

  // A PAID probe never ages into EXPIRED, so a refused order re-probes every tick forever. Past the
  // same boundary the throw path uses, that silent loop has to raise the same alarm.
  it('escalates the money-mismatch refusal once the order is far past its TTL', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: ANCIENT }],
      payments: { [id]: pendingPayment('p1', id) },
      gateway: { [`cs_${id}`]: 'PAID' },
      gatewayCharges: { [`cs_${id}`]: { amountMinor: 149_000, currency: 'vnd' } },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: id, paymentId: 'p1', stuck: true }),
      expect.stringContaining('long past its TTL — stock stays held'),
    );
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, unresolved: 1 });
  });

  it('backs off when a webhook wins the payment race mid-sweep instead of overwriting it', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: ANCIENT }],
      payments: { [id]: pendingPayment('p1', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
      updateStatusReturns: null,
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, raced: 1 });
  });

  it('fails the order when the gateway reports FAILED', async () => {
    const id = orderId(2);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p2', id) },
      gateway: { [`cs_${id}`]: 'FAILED' },
    });

    await useCase.execute(INPUT);

    expect(spies.expireSession).not.toHaveBeenCalled();
    expect(spies.updateStatus).toHaveBeenCalledWith('p2', PaymentStatus.FAILED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED', reason: 'reconcile:failed' }),
    );
  });

  it('leaves an undecided order alone while it is inside the TTL — no finalize, no payment write', async () => {
    const id = orderId(3);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p3', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.expireSession).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, stillPending: 1 });
  });

  it('closes the gateway session before expiring an order, so the page stops taking money', async () => {
    const id = orderId(4);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: LAPSED }],
      payments: { [id]: pendingPayment('p4', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
    });

    await useCase.execute(INPUT);

    expect(spies.expireSession).toHaveBeenCalledWith(`cs_${id}`);
    expect(spies.expireSession.mock.invocationCallOrder[0]).toBeLessThan(
      spies.updateStatus.mock.invocationCallOrder[0],
    );
    expect(spies.updateStatus).toHaveBeenCalledWith('p4', PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'EXPIRED', reason: 'reconcile:expired' }),
    );
  });

  it('leaves the order untouched when the gateway refuses to close a still-payable session', async () => {
    const id = orderId(4);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: LAPSED }],
      payments: { [id]: pendingPayment('p4', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
      expireThrows: [`cs_${id}`],
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, errors: 1 });
  });

  // The probe said PENDING, the buyer paid, and only the expire call found out. Backing off is what
  // makes the sweep converge: the next tick probes again and reads PAID.
  it('backs off when the buyer pays between the probe and the expire call', async () => {
    const id = orderId(4);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: LAPSED }],
      payments: { [id]: pendingPayment('p4', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
      expireReturns: { [`cs_${id}`]: 'already_completed' },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, raced: 1 });
    expect(spies.info).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: id, paymentId: 'p4' }),
      expect.stringContaining('paid mid-sweep'),
    );
  });

  // A session an earlier tick already closed, for exactly the expiry being finished here — nothing
  // is owed, so the sweep carries on and writes it.
  it('carries on expiring the order when the session was already closed', async () => {
    const id = orderId(4);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: LAPSED }],
      payments: { [id]: pendingPayment('p4', id) },
      gateway: { [`cs_${id}`]: 'PENDING' },
      expireReturns: { [`cs_${id}`]: 'already_closed' },
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).toHaveBeenCalledWith('p4', PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, finalized: 1 });
  });

  it('expires a past-TTL order that never opened a session, without calling the gateway', async () => {
    const id = orderId(5);
    const { useCase, spies } = build({ stale: [{ id, placedAt: LAPSED }], payments: { [id]: null } });

    const summary = await useCase.execute(INPUT);

    expect(spies.getPaymentStatus).not.toHaveBeenCalled();
    expect(spies.expireSession).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'EXPIRED', paymentRef: null }));
    expect(summary.finalized).toBe(1);
  });

  it('skips the payment write when a webhook already settled it, and still finalizes the order', async () => {
    const id = orderId(6);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p6', id, PaymentStatus.SUCCEEDED) },
      gateway: { [`cs_${id}`]: 'PAID' },
      finalize: 'noop',
    });

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.finalizeExec).toHaveBeenCalledOnce();
    // A `noop` means the order was already settled the same way — reconciled, but nothing moved.
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, alreadySettled: 1 });
  });

  it('warns instead of regressing when the gateway outcome conflicts with an already-settled order', async () => {
    const id = orderId(7);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: pendingPayment('p7', id, PaymentStatus.SUCCEEDED) },
      gateway: { [`cs_${id}`]: 'FAILED' },
      finalize: 'ignored',
    });

    const summary = await useCase.execute(INPUT);

    // Two distinct mismatches: the terminal payment disagrees with the gateway, and the order
    // refuses the outcome. Both need eyes, so both are logged.
    expect(spies.warn).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, unresolved: 1 });
  });

  it('isolates a gateway failure to its own order — the rest of the batch still settles', async () => {
    const broken = orderId(8);
    const healthy = orderId(9);
    const { useCase, spies } = build({
      stale: [
        { id: broken, placedAt: FRESH },
        { id: healthy, placedAt: FRESH },
      ],
      payments: { [broken]: pendingPayment('p8', broken), [healthy]: pendingPayment('p9', healthy) },
      gateway: { [`cs_${healthy}`]: 'PAID' },
      gatewayThrows: [`cs_${broken}`],
    });

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 2, finalized: 1, errors: 1 });
    expect(spies.finalizeExec).toHaveBeenCalledOnce();
    expect(spies.finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ orderId: healthy }));
  });

  it('escalates to an error once a failing order is far past its TTL and still holding stock', async () => {
    const id = orderId(8);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: ANCIENT }],
      payments: { [id]: pendingPayment('p8', id) },
      gatewayThrows: [`cs_${id}`],
    });

    await useCase.execute(INPUT);

    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(expect.objectContaining({ orderId: id, stuck: true }), expect.any(String));
  });
});
