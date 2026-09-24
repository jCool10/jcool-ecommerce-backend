import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { describe, expect, it, vi } from 'vitest';
import type { FinalizeOrderUseCase, FinalizeResult } from '@modules/order/application/public/order-finalization.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import type { OrderReadPort, StalePendingOrderView } from '../ports/order-read.port';
import type { ExpireSessionOutcome, GatewayStatus } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
import { ReconcileStaleOrdersUseCase, type ReconcileSummary } from './reconcile-stale-orders.use-case';

const INPUT = { staleAfterSec: 120, ttlSec: 900, batchSize: 50 };
const NOW = new Date('2026-08-21T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 5 * 60_000); // stale enough to sweep, well inside the TTL
const LAPSED = new Date(NOW.getTime() - 20 * 60_000); // past the TTL, not yet long enough to alert
const ANCIENT = new Date(NOW.getTime() - 60 * 60_000); // past twice the TTL

const EMPTY_SUMMARY: ReconcileSummary = {
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

// The same money as `payment()`, in the lowercase the providers send.
const MATCHING_CHARGE = { amountMinor: 150_000, currency: 'vnd' };

function payment(
  order: string,
  status: PaymentStatus = PaymentStatus.PENDING,
  providerIntentId: string | null = 'pi_known',
): Payment {
  return Payment.rehydrate({
    id: `p_${order}`,
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
  /** Per-session close outcome; anything unlisted expires cleanly. */
  expireReturns?: Record<string, ExpireSessionOutcome>;
  /** null models the compare-and-set losing to a webhook that settled the payment mid-sweep. */
  updateStatusReturns?: Payment | null;
  finalize?: FinalizeResult['status'];
}

function build(scenario: Scenario = {}) {
  const findByOrderId = vi.fn((id: string) => Promise.resolve(scenario.payments?.[id] ?? null));
  const updateStatus = vi.fn(() =>
    Promise.resolve(scenario.updateStatusReturns === undefined ? payment('o') : scenario.updateStatusReturns),
  );
  const getPaymentStatus = vi.fn((ref: string) => {
    if (scenario.gatewayThrows?.includes(ref)) return Promise.reject(new Error('gateway unreachable'));
    return Promise.resolve({
      status: scenario.gateway?.[ref] ?? 'UNKNOWN',
      intentId: scenario.gatewayIntents?.[ref],
      ...(scenario.gatewayCharges?.[ref] ?? MATCHING_CHARGE),
    });
  });
  const expireSession = vi.fn((ref: string) => Promise.resolve(scenario.expireReturns?.[ref] ?? 'expired'));
  const finalizeExec = vi.fn().mockResolvedValue({ status: scenario.finalize ?? 'finalized' });
  const warn = vi.fn();
  const error = vi.fn();

  const useCase = new ReconcileStaleOrdersUseCase(
    { findStalePending: vi.fn().mockResolvedValue(scenario.stale ?? []) } as unknown as OrderReadPort,
    fakePaymentRepository({ findByOrderId, updateStatus }),
    fakePaymentGateway({ getPaymentStatus, expireSession }),
    { execute: finalizeExec } as unknown as FinalizeOrderUseCase,
    fakePinoLogger({ warn, error }),
  );
  return { useCase, spies: { updateStatus, getPaymentStatus, expireSession, finalizeExec, warn, error } };
}

/** One lapsed order whose session the gateway still reports undecided, so the sweep must close it. */
function lapsedUndecided(expireReturn?: ExpireSessionOutcome): Scenario {
  const id = orderId(4);
  return {
    stale: [{ id, placedAt: LAPSED }],
    payments: { [id]: payment(id) },
    gateway: { [`cs_${id}`]: 'PENDING' },
    ...(expireReturn ? { expireReturns: { [`cs_${id}`]: expireReturn } } : {}),
  };
}

describe('ReconcileStaleOrdersUseCase', () => {
  useFakeClock(NOW);

  it('settles payment then order from the gateway answer, and buckets each order by what moved', async () => {
    const id = orderId(1);
    const session = `cs_${id}`;
    const one = (placedAt: Date, found: Payment | null, gateway?: GatewayStatus, finalize?: FinalizeResult['status']) =>
      build({
        stale: [{ id, placedAt }],
        payments: { [id]: found },
        gateway: gateway ? { [session]: gateway } : {},
        finalize,
      });
    const cases: Record<string, ReturnType<typeof build>> = {
      'paid at the gateway': one(FRESH, payment(id), 'PAID'),
      'failed at the gateway': one(FRESH, payment(id), 'FAILED'),
      'undecided inside the TTL': one(FRESH, payment(id), 'PENDING'),
      'lapsed with no session': one(LAPSED, null),
      'already settled the same way': one(FRESH, payment(id, PaymentStatus.SUCCEEDED), 'PAID', 'noop'),
      'order settled the other way': one(FRESH, payment(id, PaymentStatus.SUCCEEDED), 'FAILED', 'ignored'),
    };

    const outcomes = await Promise.all(
      Object.entries(cases).map(async ([label, { useCase, spies }]) => {
        const summary = await useCase.execute(INPUT);
        const buckets = Object.entries(summary).filter(([key, n]) => key !== 'scanned' && n > 0);
        return [
          label,
          Object.fromEntries(buckets),
          spies.getPaymentStatus.mock.calls.length,
          spies.updateStatus.mock.calls.map((call: unknown[]) => call[1]),
          spies.finalizeExec.mock.calls.map(([input]: unknown[]) => input),
        ];
      }),
    );

    const finalize = (outcome: string, paymentRef: string | null) => [
      { orderId: id, outcome, paymentRef, reason: `reconcile:${outcome.toLowerCase()}` },
    ];
    expect(outcomes).toEqual([
      ['paid at the gateway', { finalized: 1 }, 1, [PaymentStatus.SUCCEEDED], finalize('PAID', 'pi_known')],
      ['failed at the gateway', { finalized: 1 }, 1, [PaymentStatus.FAILED], finalize('FAILED', 'pi_known')],
      ['undecided inside the TTL', { stillPending: 1 }, 1, [], []],
      ['lapsed with no session', { finalized: 1 }, 0, [], finalize('EXPIRED', null)],
      ['already settled the same way', { alreadySettled: 1 }, 1, [], finalize('PAID', 'pi_known')],
      ['order settled the other way', { unresolved: 1 }, 1, [], finalize('FAILED', 'pi_known')],
    ]);
  });

  it('records the transaction handle the missing webhook never delivered', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: payment(id, PaymentStatus.PENDING, null) },
      gateway: { [`cs_${id}`]: 'PAID' },
      gatewayIntents: { [`cs_${id}`]: 'pi_from_gateway' },
    });

    await useCase.execute(INPUT);

    expect(spies.updateStatus).toHaveBeenCalledWith(`p_${id}`, PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.PENDING,
      providerIntentId: 'pi_from_gateway',
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: 'pi_from_gateway' }));
  });

  // Settling a paid session holding different money would pay an order out of someone else's charge.
  it('refuses to settle a paid session whose charge does not match the payment', async () => {
    const id = orderId(1);
    const { useCase, spies } = build({
      stale: [{ id, placedAt: FRESH }],
      payments: { [id]: payment(id) },
      gateway: { [`cs_${id}`]: 'PAID' },
      gatewayCharges: { [`cs_${id}`]: { amountMinor: 149_000, currency: 'vnd' } },
    });

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, unresolved: 1 });
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ stuck: true }),
      expect.any(String),
    );
  });

  // Past twice the TTL a failure is no longer transient and the stock hold will not free itself.
  it('isolates each failure, warning inside twice the TTL and escalating as stuck past it', async () => {
    const [broken, healthy, brokenAncient, mismatchAncient] = [orderId(1), orderId(2), orderId(3), orderId(4)];
    const { useCase, spies } = build({
      stale: [
        { id: broken, placedAt: FRESH },
        { id: healthy, placedAt: FRESH },
        { id: brokenAncient, placedAt: ANCIENT },
        { id: mismatchAncient, placedAt: ANCIENT },
      ],
      payments: Object.fromEntries([broken, healthy, brokenAncient, mismatchAncient].map((id) => [id, payment(id)])),
      gateway: { [`cs_${healthy}`]: 'PAID', [`cs_${mismatchAncient}`]: 'PAID' },
      gatewayCharges: { [`cs_${mismatchAncient}`]: { amountMinor: 1, currency: 'vnd' } },
      gatewayThrows: [`cs_${broken}`, `cs_${brokenAncient}`],
    });

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 4, finalized: 1, unresolved: 1, errors: 2 });
    expect(spies.finalizeExec).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ orderId: healthy }));
    expect(spies.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: broken }),
      expect.any(String),
    );
    const stuck = spies.error.mock.calls as Array<[{ orderId: string; stuck?: boolean }, string]>;
    expect(stuck.map(([fields]) => [fields.orderId, fields.stuck])).toEqual([
      [brokenAncient, true],
      [mismatchAncient, true],
    ]);
    // One alert query has to catch both ways an order stops converging.
    expect(stuck[0][1]).toBe(stuck[1][1]);
  });

  it('backs off when a webhook wins the payment race mid-sweep instead of overwriting it', async () => {
    const { useCase, spies } = build({ ...lapsedUndecided(), updateStatusReturns: null });

    const summary = await useCase.execute(INPUT);

    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, raced: 1 });
  });

  it('closes the gateway session before expiring an order, so the page stops taking money', async () => {
    const id = orderId(4);
    const { useCase, spies } = build(lapsedUndecided());

    await useCase.execute(INPUT);

    expect(spies.expireSession).toHaveBeenCalledWith(`cs_${id}`);
    expect(spies.expireSession.mock.invocationCallOrder[0]).toBeLessThan(
      spies.updateStatus.mock.invocationCallOrder[0],
    );
    expect(spies.updateStatus).toHaveBeenCalledWith(`p_${id}`, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(spies.finalizeExec).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'EXPIRED', reason: 'reconcile:expired' }),
    );
  });

  // The probe said PENDING, the buyer paid, and only the close call found out. Backing off is what
  // makes the sweep converge: the next tick probes again and reads PAID.
  it('backs off when the buyer pays between the probe and the expire call', async () => {
    const { useCase, spies } = build(lapsedUndecided('already_completed'));

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, raced: 1 });
  });

  it('carries on expiring the order when the session was already closed', async () => {
    const id = orderId(4);
    const { useCase, spies } = build(lapsedUndecided('already_closed'));

    const summary = await useCase.execute(INPUT);

    expect(spies.updateStatus).toHaveBeenCalledWith(`p_${id}`, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(summary).toEqual({ ...EMPTY_SUMMARY, scanned: 1, finalized: 1 });
  });
});
