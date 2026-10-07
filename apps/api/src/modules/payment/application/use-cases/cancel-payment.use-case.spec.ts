import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import {
  PaymentGatewayError,
  type ExpireSessionOutcome,
  type SessionAuthorization,
  type VoidOutcome,
} from '../ports/payment-gateway.port';
import type { PaymentOrderHeader } from '../ports/payment-order-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import {
  fakePaymentGateway,
  fakePaymentOrderRepository,
  fakePaymentRepository,
} from '../../testing/payment-port.doubles';
import { CancelPaymentUseCase } from './cancel-payment.use-case';

const ORDER_ID = '7400000000000000002';
const PAYMENT_ID = '7400000000000000001';
const tx = { __tx: true } as unknown as DrizzleTx;

const header = (status: PaymentOrderStatus): PaymentOrderHeader => ({
  orderId: ORDER_ID,
  status,
  amountMinor: 150_000,
  currency: 'VND',
});
const payment = (status: PaymentStatus, intentId: string | null = null) =>
  Payment.rehydrate({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: 'cs_1',
    providerIntentId: intentId,
    amountMinor: 150_000,
    currency: 'VND',
    status,
  });

interface Setup {
  /** Header each read in the first transaction returns, in order. */
  headers?: (PaymentOrderHeader | null)[];
  inserted?: boolean;
  /** Rows seen by the unlocked scan, and by the locked read of the second transaction. */
  scanned?: Payment[];
  locked?: Payment[];
  expire?: ExpireSessionOutcome;
  authorization?: SessionAuthorization;
  void?: () => Promise<VoidOutcome>;
}

function build(setup: Setup = {}) {
  const calls: string[] = [];
  const run = vi.fn(async (work: (t: DrizzleTx) => Promise<unknown>) => {
    calls.push('tx');
    const result = await work(tx);
    calls.push('commit');
    return result;
  });
  const findHeader = vi.fn();
  for (const h of setup.headers ?? [header(PaymentOrderStatus.OPEN)]) findHeader.mockResolvedValueOnce(h);
  findHeader.mockResolvedValue(header(PaymentOrderStatus.CANCELLED));
  const insertIfAbsent = vi.fn().mockResolvedValue(setup.inserted ?? true);
  const updateHeader = vi.fn(() => {
    calls.push('flip header');
    return Promise.resolve(true);
  });
  const scanned = setup.scanned ?? [];
  const findAll = vi.fn((_orderId: string, lockTx?: unknown) =>
    Promise.resolve(lockTx === undefined ? scanned : (setup.locked ?? scanned)),
  );
  const updatePayment = vi.fn().mockResolvedValue({});
  const bumpKeyGen = vi.fn().mockResolvedValue(true);
  const expireSession = vi.fn(() => {
    calls.push('expire');
    return Promise.resolve(setup.expire ?? 'expired');
  });
  const retrieveAuthorization = vi.fn().mockResolvedValue(setup.authorization ?? { sessionStatus: 'open' });
  const voidIntent = vi.fn(() => {
    calls.push('void');
    return setup.void ? setup.void() : Promise.resolve<VoidOutcome>('voided');
  });
  const error = vi.fn();
  const metrics = fakeMetricsPort();

  const useCase = new CancelPaymentUseCase(
    { run } as unknown as TransactionRunnerPort,
    fakePaymentOrderRepository({ findForUpdate: findHeader, insertIfAbsent, updateStatus: updateHeader }),
    fakePaymentRepository({ findAllByOrderId: findAll, updateStatus: updatePayment, bumpKeyGen }),
    fakePaymentGateway({ expireSession, retrieveAuthorization, void: voidIntent }),
    metrics,
    fakePinoLogger({ error }),
  );
  return {
    useCase,
    calls,
    run,
    insertIfAbsent,
    updateHeader,
    updatePayment,
    bumpKeyGen,
    expireSession,
    retrieveAuthorization,
    voidIntent,
    error,
    metrics,
  };
}

describe('CancelPaymentUseCase', () => {
  // A later open then finds the fence up and opens nothing.
  it('fences an order that never opened, with no money on the header', async () => {
    const { useCase, insertIfAbsent, expireSession, metrics } = build({
      headers: [null, header(PaymentOrderStatus.FENCED)],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'FENCED' });
    expect(insertIfAbsent).toHaveBeenCalledWith(tx, {
      orderId: ORDER_ID,
      status: PaymentOrderStatus.FENCED,
      amountMinor: null,
      currency: null,
    });
    expect(expireSession).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'fenced');
  });

  it('follows an open that won the race to insert the header', async () => {
    const { useCase, updateHeader } = build({ headers: [null, header(PaymentOrderStatus.OPEN)], inserted: false });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(updateHeader).toHaveBeenCalledWith(tx, ORDER_ID, PaymentOrderStatus.CANCELLED, PaymentOrderStatus.OPEN);
  });

  // Flipped first, so an open racing this cancel sees CANCELLED in its own second transaction.
  it('commits the cancelled header before any gateway call, then expires the open session', async () => {
    const { useCase, calls, updatePayment, metrics } = build({ scanned: [payment(PaymentStatus.PENDING)] });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(calls).toEqual(['tx', 'flip header', 'commit', 'expire', 'tx', 'commit']);
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.EXPIRED, {
      tx,
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'ok');
  });

  it('voids an authorized hold under its own key', async () => {
    const { useCase, voidIntent, updatePayment } = build({
      headers: [header(PaymentOrderStatus.AUTHORIZED)],
      scanned: [payment(PaymentStatus.AUTHORIZED, 'pi_1')],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(voidIntent).toHaveBeenCalledWith('pi_1', `void:${PAYMENT_ID}:0`);
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.VOIDED, {
      tx,
      expectedStatus: PaymentStatus.AUTHORIZED,
      providerIntentId: 'pi_1',
    });
  });

  it('raises the alarm and calls no gateway when the order was already captured', async () => {
    const { useCase, expireSession, voidIntent, updateHeader, metrics } = build({
      headers: [header(PaymentOrderStatus.CAPTURED)],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect(updateHeader).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
    expect(voidIntent).not.toHaveBeenCalled();
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'conflict');
  });

  // The buyer finished the page just before it closed: the hold it placed must still be released.
  it('voids the hold of a session the buyer completed before it could be expired', async () => {
    const { useCase, retrieveAuthorization, voidIntent, updatePayment } = build({
      scanned: [payment(PaymentStatus.PENDING)],
      expire: 'already_completed',
      authorization: { sessionStatus: 'complete', intentId: 'pi_late', intentStatus: 'requires_capture' },
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(retrieveAuthorization).toHaveBeenCalledWith('cs_1');
    expect(voidIntent).toHaveBeenCalledWith('pi_late', `void:${PAYMENT_ID}:0`);
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.VOIDED, {
      tx,
      expectedStatus: PaymentStatus.PENDING,
      providerIntentId: 'pi_late',
    });
  });

  // No payment and no header is left AUTHORIZED once the cancel returns.
  it('voids a payment the webhook authorized between its two transactions', async () => {
    const { useCase, updatePayment } = build({
      scanned: [payment(PaymentStatus.PENDING)],
      locked: [payment(PaymentStatus.AUTHORIZED, 'pi_late')],
      expire: 'already_completed',
      authorization: { sessionStatus: 'complete', intentId: 'pi_late', intentStatus: 'requires_capture' },
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.VOIDED, {
      tx,
      expectedStatus: PaymentStatus.AUTHORIZED,
      providerIntentId: 'pi_late',
    });
  });

  it('sweeps a late hold under a header it already cancelled, leaving the header alone', async () => {
    const { useCase, updateHeader, voidIntent, metrics } = build({
      headers: [header(PaymentOrderStatus.CANCELLED)],
      scanned: [payment(PaymentStatus.AUTHORIZED, 'pi_late')],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(updateHeader).not.toHaveBeenCalled();
    expect(voidIntent).toHaveBeenCalledOnce();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'idempotent');
  });

  // A capture that landed after the flip leaves the header CANCELLED: a retry must not read that as clean.
  it('keeps answering a conflict for money a capture took after the header closed', async () => {
    const { useCase, expireSession, voidIntent, updatePayment, metrics } = build({
      headers: [header(PaymentOrderStatus.CANCELLED)],
      scanned: [payment(PaymentStatus.SUCCEEDED, 'pi_1')],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect(expireSession).not.toHaveBeenCalled();
    expect(voidIntent).not.toHaveBeenCalled();
    expect(updatePayment).not.toHaveBeenCalled();
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'conflict');
  });

  it('does not overwrite a payment that moved to a status no settlement starts from', async () => {
    const { useCase, updatePayment } = build({
      scanned: [payment(PaymentStatus.PENDING)],
      locked: [payment(PaymentStatus.FAILED)],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it('records a void that found the money captured as a conflict', async () => {
    const { useCase, updatePayment, metrics } = build({
      headers: [header(PaymentOrderStatus.AUTHORIZED)],
      scanned: [payment(PaymentStatus.AUTHORIZED, 'pi_1')],
      void: () => Promise.resolve('already_captured'),
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED_CONFLICT' });
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.SUCCEEDED, expect.anything());
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
  });

  it('rotates the void key and throws when a 5xx left the hold in place', async () => {
    const { useCase, bumpKeyGen, updatePayment } = build({
      headers: [header(PaymentOrderStatus.AUTHORIZED)],
      scanned: [payment(PaymentStatus.AUTHORIZED, 'pi_1')],
      void: () => Promise.reject(new PaymentGatewayError('Stripe void failed', undefined, { retryWithFreshKey: true })),
    });

    await expect(useCase.execute(ORDER_ID)).rejects.toMatchObject({ retryWithFreshKey: true });
    expect(bumpKeyGen).toHaveBeenCalledWith(PAYMENT_ID, 0, tx);
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it('throws a transient gateway fault after the header flip, so the retry sweeps again', async () => {
    const { useCase, expireSession, updateHeader, metrics } = build({ scanned: [payment(PaymentStatus.PENDING)] });
    expireSession.mockRejectedValueOnce(new PaymentGatewayError('gateway down'));

    await expect(useCase.execute(ORDER_ID)).rejects.toBeInstanceOf(PaymentGatewayError);
    expect(updateHeader).toHaveBeenCalledOnce();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'cancel', 'error');
  });
});
