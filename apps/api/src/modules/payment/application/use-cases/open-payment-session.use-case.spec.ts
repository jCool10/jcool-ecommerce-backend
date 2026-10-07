import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { GatewaySession, RetrievedSession } from '../ports/payment-gateway.port';
import type { PaymentOrderHeader } from '../ports/payment-order-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import {
  fakePaymentGateway,
  fakePaymentOrderRepository,
  fakePaymentRepository,
} from '../../testing/payment-port.doubles';
import { OpenPaymentSessionUseCase } from './open-payment-session.use-case';

const ORDER_ID = '7400000000000000002';
const NEW_PAYMENT_ID = '7400000000000000011';
const OLD_PAYMENT_ID = '7400000000000000010';
const FLOOR_SEC = 1_800 + 120;
const NEW_SESSION: GatewaySession = { providerSessionId: 'cs_new', redirectUrl: 'https://pay.test/cs_new' };
const tx = { __tx: true } as unknown as DrizzleTx;

const deadline = (fromNowSec = FLOOR_SEC + 60) => new Date(Date.now() + fromNowSec * 1000);
const header = (status: PaymentOrderStatus, amountMinor = 150_000): PaymentOrderHeader => ({
  orderId: ORDER_ID,
  status,
  amountMinor,
  currency: 'VND',
});
const attempt = (id: string, sessionId: string, status: PaymentStatus) =>
  Payment.rehydrate({
    id,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: sessionId,
    providerIntentId: null,
    amountMinor: 150_000,
    currency: 'VND',
    status,
  });
const pending = (id: string, sessionId: string) => attempt(id, sessionId, PaymentStatus.PENDING);

interface Setup {
  /** Header seen by the first and the second transaction. */
  headers?: [PaymentOrderHeader, PaymentOrderHeader?];
  /** The active payment each transaction finds. */
  active?: [Payment | null, (Payment | null)?];
  probe?: RetrievedSession;
}

function build(setup: Setup = {}) {
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
  const [first, second = first] = setup.headers ?? [header(PaymentOrderStatus.OPEN)];
  const [activeFirst, activeSecond = null] = setup.active ?? [null];

  const insertIfAbsent = vi.fn().mockResolvedValue(true);
  const findHeader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const findActive = vi.fn().mockResolvedValueOnce(activeFirst).mockResolvedValueOnce(activeSecond);
  const create = vi.fn((payment: Payment, _tx: unknown, id: string) =>
    Promise.resolve(Payment.rehydrate({ ...payment, id, providerIntentId: null })),
  );
  const updateStatus = vi.fn().mockResolvedValue({});
  const createSession = vi.fn(() => {
    calls.push('createSession');
    return Promise.resolve(NEW_SESSION);
  });
  const retrieveSession = vi.fn().mockResolvedValue(setup.probe ?? { status: 'PENDING' });
  const expireSession = vi.fn().mockResolvedValue('expired');
  const mint = vi.fn(() => {
    calls.push(inTx ? 'mint inside tx' : 'mint');
    return Promise.resolve([NEW_PAYMENT_ID]);
  });
  const error = vi.fn();
  const metrics = fakeMetricsPort();

  const useCase = new OpenPaymentSessionUseCase(
    { run } as unknown as TransactionRunnerPort,
    fakePaymentOrderRepository({ insertIfAbsent, findForUpdate: findHeader }),
    fakePaymentRepository({ findActiveByOrderIdForUpdate: findActive, create, updateStatus }),
    fakePaymentGateway({ createSession, retrieveSession, expireSession }),
    { mint },
    fakeConfigService({ 'payment.sessionMinTtlSec': 1_800, 'payment.sessionExpiryMarginSec': 120 }),
    metrics,
    fakePinoLogger({ error }),
  );
  return {
    useCase,
    calls,
    run,
    insertIfAbsent,
    create,
    updateStatus,
    createSession,
    retrieveSession,
    expireSession,
    mint,
    error,
    metrics,
  };
}

const open = (expiresAt = deadline(), amountMinor = 150_000) => ({
  orderId: ORDER_ID,
  amountMinor,
  currency: 'vnd',
  expiresAt,
});

describe('OpenPaymentSessionUseCase', () => {
  it('fences a new order and opens a manual-capture session for it', async () => {
    const { useCase, insertIfAbsent, createSession, create, metrics } = build();
    const input = open();

    await expect(useCase.execute(input)).resolves.toEqual({
      outcome: 'OPENED',
      paymentId: NEW_PAYMENT_ID,
      providerSessionId: 'cs_new',
      redirectUrl: 'https://pay.test/cs_new',
      clientSecret: undefined,
    });
    expect(insertIfAbsent).toHaveBeenCalledWith(tx, {
      orderId: ORDER_ID,
      status: PaymentOrderStatus.OPEN,
      amountMinor: 150_000,
      currency: 'VND',
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        amountMinor: 150_000,
        captureMethod: 'manual',
        expiresAt: input.expiresAt,
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: 'cs_new', status: PaymentStatus.PENDING }),
      tx,
      NEW_PAYMENT_ID,
    );
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'open_session', 'ok');
  });

  // Inside a transaction it would hold the header lock across a network call; after the session, an
  // id-service fault would leave that session with no row.
  it('mints the payment id outside both transactions, before the session is opened', async () => {
    const { useCase, calls } = build();

    await useCase.execute(open());

    expect(calls).toEqual(['tx', 'mint', 'createSession', 'tx']);
  });

  it('refuses a non-positive amount before recording it on the header', async () => {
    const { useCase, run, createSession } = build();

    await expect(useCase.execute(open(deadline(), 0))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  // Released out of band (dashboard, lapsed authorization), the hold still fills the order's one active slot.
  it('closes when the active attempt under an open header has already settled', async () => {
    const { useCase, retrieveSession, createSession, metrics } = build({
      active: [attempt(OLD_PAYMENT_ID, 'cs_old', PaymentStatus.VOIDED)],
    });

    await expect(useCase.execute(open())).resolves.toEqual({ outcome: 'CLOSED' });
    expect(retrieveSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'open_session', 'conflict');
  });

  it('hands back the session that is still open instead of opening another', async () => {
    const { useCase, retrieveSession, createSession, metrics } = build({
      active: [pending(OLD_PAYMENT_ID, 'cs_old')],
      probe: { status: 'PENDING', redirectUrl: 'https://pay.test/cs_old' },
    });

    await expect(useCase.execute(open())).resolves.toEqual({
      outcome: 'OPENED',
      paymentId: OLD_PAYMENT_ID,
      providerSessionId: 'cs_old',
      redirectUrl: 'https://pay.test/cs_old',
      clientSecret: undefined,
    });
    expect(retrieveSession).toHaveBeenCalledWith('cs_old');
    expect(createSession).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'open_session', 'idempotent');
  });

  it('retires an attempt the gateway reports dead, in the transaction that records the fresh one', async () => {
    const { useCase, updateStatus, create } = build({
      active: [pending(OLD_PAYMENT_ID, 'cs_old')],
      probe: { status: 'FAILED' },
    });

    await expect(useCase.execute(open())).resolves.toMatchObject({ outcome: 'OPENED', paymentId: NEW_PAYMENT_ID });
    expect(updateStatus).toHaveBeenCalledWith(OLD_PAYMENT_ID, PaymentStatus.FAILED, {
      tx,
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(updateStatus.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  // UNKNOWN is no proof the old page is dead; a second session could take the money twice.
  it('throws rather than open a second session beside one it cannot read', async () => {
    const { useCase, createSession, metrics } = build({
      active: [pending(OLD_PAYMENT_ID, 'cs_old')],
      probe: { status: 'UNKNOWN' },
    });

    await expect(useCase.execute(open())).rejects.toThrow();
    expect(createSession).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'open_session', 'error');
  });

  it('closes on any header that is no longer open, without touching the gateway', async () => {
    const closed = [
      PaymentOrderStatus.AUTHORIZED,
      PaymentOrderStatus.CAPTURED,
      PaymentOrderStatus.CANCELLED,
      PaymentOrderStatus.FENCED,
    ];

    for (const status of closed) {
      const { useCase, createSession, retrieveSession } = build({ headers: [header(status)] });

      await expect(useCase.execute(open()), status).resolves.toEqual({ outcome: 'CLOSED' });
      expect(createSession, status).not.toHaveBeenCalled();
      expect(retrieveSession, status).not.toHaveBeenCalled();
    }
  });

  it('refuses an amount that differs from the one the order was first opened for', async () => {
    const { useCase, createSession, error } = build({ headers: [header(PaymentOrderStatus.OPEN, 150_000)] });

    await expect(useCase.execute(open(deadline(), 160_000))).resolves.toEqual({ outcome: 'CLOSED' });
    expect(createSession).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  // Stripe refuses a session shorter than its minimum; the order should see "window closed", not a 500.
  it('refuses a deadline under the session floor before touching the database or the gateway', async () => {
    const { useCase, run, createSession, metrics } = build();

    await expect(useCase.execute(open(deadline(FLOOR_SEC - 5)))).resolves.toEqual({ outcome: 'CLOSED' });
    expect(run).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'open_session', 'rejected');
  });

  // A cancel that commits between the two transactions finds no session to close: this call closes it.
  it('expires the session it just opened when a cancel landed between its two transactions', async () => {
    const { useCase, create, expireSession, updateStatus } = build({
      headers: [header(PaymentOrderStatus.OPEN), header(PaymentOrderStatus.CANCELLED)],
    });

    await expect(useCase.execute(open())).resolves.toEqual({ outcome: 'CLOSED' });
    expect(create).toHaveBeenCalledOnce();
    expect(expireSession).toHaveBeenCalledWith('cs_new');
    expect(updateStatus).toHaveBeenCalledWith(NEW_PAYMENT_ID, PaymentStatus.EXPIRED, {
      expectedStatus: PaymentStatus.PENDING,
    });
  });

  // Left PENDING and visible, so the cancel sweep or reconcile can still close it.
  it('keeps the row when that session refuses to expire', async () => {
    const { useCase, expireSession, updateStatus, error } = build({
      headers: [header(PaymentOrderStatus.OPEN), header(PaymentOrderStatus.CANCELLED)],
    });
    expireSession.mockRejectedValueOnce(new Error('gateway down'));

    await expect(useCase.execute(open())).resolves.toEqual({ outcome: 'CLOSED' });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('expires its own session and throws when a concurrent open recorded one first', async () => {
    const { useCase, create, expireSession } = build({ active: [null, pending(OLD_PAYMENT_ID, 'cs_other')] });

    await expect(useCase.execute(open())).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(expireSession).toHaveBeenCalledWith('cs_new');
  });
});
