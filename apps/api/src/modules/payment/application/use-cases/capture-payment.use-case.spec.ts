import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentGatewayError, type CaptureResult } from '../ports/payment-gateway.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import {
  fakePaymentGateway,
  fakePaymentOrderRepository,
  fakePaymentRepository,
} from '../../testing/payment-port.doubles';
import { CapturePaymentUseCase } from './capture-payment.use-case';

const ORDER_ID = '7400000000000000002';
const PAYMENT_ID = '7400000000000000001';
const tx = { __tx: true } as unknown as DrizzleTx;

const withStatus = (status: PaymentStatus, keyGen = 0) =>
  Payment.rehydrate({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: 'cs_1',
    providerIntentId: 'pi_1',
    amountMinor: 150_000,
    currency: 'VND',
    status,
    authorizedAt: new Date('2026-10-06T10:00:00Z'),
    idempotencyKeyGen: keyGen,
  });
const authorized = (keyGen = 0) => withStatus(PaymentStatus.AUTHORIZED, keyGen);

const headerOf = (status: PaymentOrderStatus | null) =>
  status === null ? null : { orderId: ORDER_ID, status, amountMinor: 150_000, currency: 'VND' };

interface Setup {
  /** Header the unlocked first read sees. */
  header?: PaymentOrderStatus | null;
  /** Header the write-back transaction finds once it holds the lock. */
  locked?: PaymentOrderStatus;
  /** Every attempt recorded for the order. */
  attempts?: Payment[];
  capture?: () => Promise<CaptureResult>;
}

function build(opts: Setup = {}) {
  const headerStatus = opts.header === undefined ? PaymentOrderStatus.AUTHORIZED : opts.header;
  const findHeader = vi.fn().mockResolvedValue(headerOf(headerStatus));
  const lockHeader = vi.fn().mockResolvedValue(headerOf(opts.locked ?? PaymentOrderStatus.AUTHORIZED));
  const updateHeader = vi.fn().mockResolvedValue(true);
  const findPayment = vi.fn().mockResolvedValue(authorized());
  const findAttempts = vi.fn().mockResolvedValue(opts.attempts ?? []);
  const updatePayment = vi.fn().mockResolvedValue({});
  const bumpKeyGen = vi.fn().mockResolvedValue(true);
  const capture = vi.fn(opts.capture ?? (() => Promise.resolve<CaptureResult>({ kind: 'captured' })));
  const run = vi.fn((work: (t: DrizzleTx) => Promise<unknown>) => work(tx));
  const error = vi.fn();
  const metrics = fakeMetricsPort();

  const useCase = new CapturePaymentUseCase(
    { run } as unknown as TransactionRunnerPort,
    fakePaymentOrderRepository({ find: findHeader, findForUpdate: lockHeader, updateStatus: updateHeader }),
    fakePaymentRepository({
      findByOrderId: findPayment,
      findAllByOrderId: findAttempts,
      updateStatus: updatePayment,
      bumpKeyGen,
    }),
    fakePaymentGateway({ capture }),
    metrics,
    fakePinoLogger({ error }),
  );
  return { useCase, run, lockHeader, updateHeader, findPayment, updatePayment, bumpKeyGen, capture, error, metrics };
}

describe('CapturePaymentUseCase', () => {
  it('captures an authorized hold and records it on the header and the payment together', async () => {
    const { useCase, capture, updateHeader, updatePayment, metrics } = build();

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });

    expect(capture).toHaveBeenCalledWith('pi_1', `capture:${PAYMENT_ID}:0`);
    expect(updateHeader).toHaveBeenCalledWith(tx, ORDER_ID, PaymentOrderStatus.CAPTURED, PaymentOrderStatus.AUTHORIZED);
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.SUCCEEDED, {
      tx,
      expectedStatus: PaymentStatus.AUTHORIZED,
    });
    // Header before payment, as in every fenced transaction.
    expect(updateHeader.mock.invocationCallOrder[0]).toBeLessThan(updatePayment.mock.invocationCallOrder[0]);
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'ok');
  });

  it('answers a repeat capture from the header without calling the gateway', async () => {
    const { useCase, capture, metrics } = build({ header: PaymentOrderStatus.CAPTURED });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(capture).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'idempotent');
  });

  it('refuses to capture an order with no hold behind its header', async () => {
    const statuses = [null, PaymentOrderStatus.OPEN, PaymentOrderStatus.CANCELLED, PaymentOrderStatus.FENCED] as const;

    for (const header of statuses) {
      const { useCase, capture } = build({ header, attempts: [withStatus(PaymentStatus.VOIDED)] });

      await expect(useCase.execute(ORDER_ID), String(header)).resolves.toEqual({ outcome: 'NOT_CAPTURABLE' });
      expect(capture, String(header)).not.toHaveBeenCalled();
    }
  });

  // The header stays as the cancel left it, so only the payment can tell a retry the money was taken.
  it('keeps answering captured for money a capture took after a cancel closed the header', async () => {
    const { useCase, capture, metrics } = build({
      header: PaymentOrderStatus.CANCELLED,
      attempts: [withStatus(PaymentStatus.SUCCEEDED)],
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(capture).not.toHaveBeenCalled();
    expect(metrics.recordCaptureConflict).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'idempotent');
  });

  // A 409 means the same key is still running at Stripe, and may yet succeed.
  it('throws an unknown outcome without touching any state, keeping the key', async () => {
    const { useCase, run, metrics } = build({
      capture: () => Promise.reject(new PaymentGatewayError('Stripe capture failed (idempotency_error)')),
    });

    await expect(useCase.execute(ORDER_ID)).rejects.toBeInstanceOf(PaymentGatewayError);
    expect(run).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'error');
  });

  it('fails the payment and cancels the header when the hold is gone', async () => {
    const { useCase, updateHeader, updatePayment, metrics } = build({
      capture: () => Promise.resolve<CaptureResult>({ kind: 'not_capturable', intentStatus: 'canceled' }),
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'NOT_CAPTURABLE' });
    expect(updateHeader).toHaveBeenCalledWith(
      tx,
      ORDER_ID,
      PaymentOrderStatus.CANCELLED,
      PaymentOrderStatus.AUTHORIZED,
    );
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.FAILED, {
      tx,
      expectedStatus: PaymentStatus.AUTHORIZED,
    });
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'rejected');
  });

  // Its void found the hold gone and records how it ended; FAILED would hide that.
  it('leaves the payment to the cancel that closed the header before the hold turned out gone', async () => {
    const { useCase, updateHeader, updatePayment } = build({
      capture: () => Promise.resolve<CaptureResult>({ kind: 'not_capturable', intentStatus: 'canceled' }),
    });
    updateHeader.mockResolvedValueOnce(false);

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'NOT_CAPTURABLE' });
    expect(updatePayment).not.toHaveBeenCalled();
  });

  // The money moved, so the payment says so; the header a cancel already flipped is not overwritten.
  it('raises the conflict alarm when a cancel flipped the header while the capture ran', async () => {
    const { useCase, updateHeader, updatePayment, error, metrics } = build({ locked: PaymentOrderStatus.CANCELLED });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(updateHeader).not.toHaveBeenCalled();
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.SUCCEEDED, {
      tx,
      expectedStatus: PaymentStatus.AUTHORIZED,
    });
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('raises the alarm once when the cancel side already recorded the captured money', async () => {
    const { useCase, updatePayment, metrics } = build({ locked: PaymentOrderStatus.CANCELLED });
    updatePayment.mockResolvedValueOnce(null);

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(metrics.recordCaptureConflict).not.toHaveBeenCalled();
  });

  // Two overlapping calls both reach Stripe under one key and both get its captured answer.
  it('treats a capture another call recorded first as a repeat, not a refund case', async () => {
    const { useCase, updateHeader, updatePayment, error, metrics } = build({ locked: PaymentOrderStatus.CAPTURED });

    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(updateHeader).not.toHaveBeenCalled();
    expect(updatePayment).not.toHaveBeenCalled();
    expect(metrics.recordCaptureConflict).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'idempotent');
  });

  // Stripe replays a stored 5xx for the old key forever; only the generation bump gets past it.
  it('rotates the key and throws when a 5xx left the hold capturable, then captures under the new key', async () => {
    const { useCase, lockHeader, bumpKeyGen, updatePayment, capture, findPayment } = build({
      capture: () =>
        Promise.reject(new PaymentGatewayError('Stripe capture failed', undefined, { retryWithFreshKey: true })),
    });

    await expect(useCase.execute(ORDER_ID)).rejects.toMatchObject({ retryWithFreshKey: true });
    expect(lockHeader).toHaveBeenCalledWith(tx, ORDER_ID);
    expect(bumpKeyGen).toHaveBeenCalledWith(PAYMENT_ID, 0, tx);
    expect(updatePayment).not.toHaveBeenCalled();

    findPayment.mockResolvedValueOnce(authorized(1));
    capture.mockResolvedValueOnce({ kind: 'captured' });
    await expect(useCase.execute(ORDER_ID)).resolves.toEqual({ outcome: 'CAPTURED' });
    expect(capture).toHaveBeenLastCalledWith('pi_1', `capture:${PAYMENT_ID}:1`);
  });
});
