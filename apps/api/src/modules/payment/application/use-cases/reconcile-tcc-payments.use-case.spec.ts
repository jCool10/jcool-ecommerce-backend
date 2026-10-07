import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentGatewayError, type SessionAuthorization } from '../ports/payment-gateway.port';
import type { StaleTccPayment } from '../ports/payment-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import {
  fakePaymentGateway,
  fakePaymentOrderRepository,
  fakePaymentRepository,
} from '../../testing/payment-port.doubles';
import type { RecordAuthorizationUseCase } from './record-authorization.use-case';
import { ReconcileTccPaymentsUseCase } from './reconcile-tcc-payments.use-case';

const ORDER_ID = '7400000000000000002';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const OUTBOX_ID = '7400000000000000009';
const tx = { __tx: true } as unknown as DrizzleTx;

const stale = (
  id: string,
  status: PaymentStatus,
  headerStatus: PaymentOrderStatus = PaymentOrderStatus.OPEN,
): StaleTccPayment => ({
  payment: Payment.rehydrate({
    id,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: `cs_${id}`,
    providerIntentId: status === PaymentStatus.AUTHORIZED ? `pi_${id}` : null,
    amountMinor: 150_000,
    currency: 'VND',
    status,
  }),
  headerStatus,
});

function build(rows: StaleTccPayment[], authorizations: Record<string, SessionAuthorization | Error> = {}) {
  const calls: string[] = [];
  let inTx = false;
  const run = vi.fn(async (work: (t: DrizzleTx) => Promise<unknown>) => {
    calls.push('tx');
    inTx = true;
    try {
      return await work(tx);
    } finally {
      inTx = false;
    }
  });
  const findStaleTcc = vi.fn().mockResolvedValue(rows);
  const touch = vi.fn().mockResolvedValue(undefined);
  const updateStatus = vi.fn().mockResolvedValue({});
  const bumpKeyGen = vi.fn().mockResolvedValue(true);
  const retrieveAuthorization = vi.fn((ref: string) => {
    const found = authorizations[ref] ?? { sessionStatus: 'open' };
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  });
  const expireSession = vi.fn().mockResolvedValue('expired');
  const voidIntent = vi.fn().mockResolvedValue('voided');
  const mint = vi.fn(() => {
    calls.push(inTx ? 'mint inside tx' : 'mint');
    return Promise.resolve([OUTBOX_ID]);
  });
  const record = vi.fn().mockResolvedValue({ outcome: 'authorized' });
  const metrics = fakeMetricsPort();

  const useCase = new ReconcileTccPaymentsUseCase(
    { run } as unknown as TransactionRunnerPort,
    fakePaymentOrderRepository({ findForUpdate: vi.fn().mockResolvedValue({}) }),
    fakePaymentRepository({ findStaleTcc, touch, updateStatus, bumpKeyGen }),
    fakePaymentGateway({ retrieveAuthorization, expireSession, void: voidIntent }),
    { mint },
    { execute: record } as unknown as RecordAuthorizationUseCase,
    metrics,
    fakePinoLogger(),
  );
  return { useCase, calls, findStaleTcc, touch, updateStatus, bumpKeyGen, expireSession, voidIntent, record, metrics };
}

const SWEEP = { staleAfterSec: 600, batchSize: 25 };

describe('ReconcileTccPaymentsUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the least recently touched fenced payments older than the threshold', async () => {
    const { useCase, findStaleTcc } = build([]);

    await useCase.execute(SWEEP);

    expect(findStaleTcc).toHaveBeenCalledWith({ untouchedSince: new Date(NOW.getTime() - 600_000), limit: 25 });
  });

  // A lost webhook still converges: the probe records the hold exactly as the webhook would have.
  it('records a hold the webhook never delivered, minting the event id before the transaction', async () => {
    const authorization: SessionAuthorization = {
      sessionStatus: 'complete',
      intentId: 'pi_1',
      intentStatus: 'requires_capture',
      amountCapturableMinor: 150_000,
      currency: 'vnd',
    };
    const { useCase, calls, record } = build([stale('1', PaymentStatus.PENDING)], { cs_1: authorization });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ scanned: 1, authorized: 1 });
    expect(calls).toEqual(['mint', 'tx']);
    expect(record).toHaveBeenCalledWith(tx, {
      orderId: ORDER_ID,
      providerSessionId: 'cs_1',
      authorization,
      authorizedAt: NOW,
      outboxId: OUTBOX_ID,
    });
  });

  it('settles a pending payment whose session lapsed or whose hold Stripe already released', async () => {
    const { useCase, updateStatus } = build([stale('1', PaymentStatus.PENDING), stale('2', PaymentStatus.PENDING)], {
      cs_1: { sessionStatus: 'expired' },
      cs_2: { sessionStatus: 'complete', intentId: 'pi_2', intentStatus: 'canceled' },
    });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ expired: 1, voided: 1 });
    expect(updateStatus).toHaveBeenCalledWith('1', PaymentStatus.EXPIRED, { expectedStatus: PaymentStatus.PENDING });
    expect(updateStatus).toHaveBeenCalledWith('2', PaymentStatus.VOIDED, {
      expectedStatus: PaymentStatus.PENDING,
      providerIntentId: 'pi_2',
    });
  });

  // The backstop for a session an open created under a cancel and then failed to close.
  it('closes a session still open under a cancelled or fenced header', async () => {
    const { useCase, expireSession, updateStatus } = build([
      stale('1', PaymentStatus.PENDING, PaymentOrderStatus.CANCELLED),
      stale('2', PaymentStatus.PENDING, PaymentOrderStatus.OPEN),
    ]);

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ expired: 1, undecided: 1 });
    expect(expireSession).toHaveBeenCalledExactlyOnceWith('cs_1');
    expect(updateStatus).toHaveBeenCalledExactlyOnceWith('1', PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
  });

  it('voids a hold left authorized under a cancelled header', async () => {
    const { useCase, voidIntent, updateStatus } = build([
      stale('1', PaymentStatus.AUTHORIZED, PaymentOrderStatus.CANCELLED),
    ]);

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ voided: 1 });
    expect(voidIntent).toHaveBeenCalledWith('pi_1', 'void:1:0');
    expect(updateStatus).toHaveBeenCalledWith('1', PaymentStatus.VOIDED, { expectedStatus: PaymentStatus.AUTHORIZED });
  });

  it('rotates the void key after a stored 5xx and leaves the row for the next tick', async () => {
    const { useCase, voidIntent, bumpKeyGen } = build([
      stale('1', PaymentStatus.AUTHORIZED, PaymentOrderStatus.CANCELLED),
    ]);
    voidIntent.mockRejectedValueOnce(new PaymentGatewayError('5xx', undefined, { retryWithFreshKey: true }));

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ errors: 1 });
    expect(bumpKeyGen).toHaveBeenCalledWith('1', 0, tx);
  });

  it('records a hold Stripe reports captured under a cancelled order, and raises the conflict once', async () => {
    const { useCase, voidIntent, updateStatus, metrics } = build([
      stale('1', PaymentStatus.AUTHORIZED, PaymentOrderStatus.CANCELLED),
    ]);
    voidIntent.mockResolvedValueOnce('already_captured');

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ conflicts: 1 });
    expect(updateStatus).toHaveBeenCalledWith('1', PaymentStatus.SUCCEEDED, {
      expectedStatus: PaymentStatus.AUTHORIZED,
    });
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
  });

  // Otherwise a batch of rows that never resolve would be the only rows any tick ever reads.
  it('moves every probed row to the back of the queue, whatever the probe found', async () => {
    const { useCase, touch } = build([stale('1', PaymentStatus.PENDING), stale('2', PaymentStatus.PENDING)], {
      cs_2: new PaymentGatewayError('gateway down'),
    });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ scanned: 2, undecided: 1, errors: 1 });
    expect(touch.mock.calls).toEqual([['1'], ['2']]);
  });

  // `authorized_at` belongs to the recorder alone; a probe that settles nothing writes nothing else.
  it('leaves an unresolved hold exactly as it was apart from its place in the queue', async () => {
    const { useCase, voidIntent, touch, updateStatus } = build([
      stale('1', PaymentStatus.AUTHORIZED, PaymentOrderStatus.FENCED),
    ]);
    voidIntent.mockRejectedValueOnce(new PaymentGatewayError('Stripe void failed (idempotency_error)'));

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ errors: 1 });
    expect(touch).toHaveBeenCalledExactlyOnceWith('1');
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
