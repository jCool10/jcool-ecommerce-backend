import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentRefundStatus } from '../../domain/payment-refund-status';
import { PaymentStatus } from '../../domain/payment-status';
import { fakeRefundGateway } from '../../testing/fake-refund-gateway';
import { CHARGE, InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { PaymentGatewayError } from '../ports/payment-gateway.port';
import { RefundPaymentUseCase } from './refund-payment.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';
const ADMIN = '9001';
const OTHER_ADMIN = '9002';

function setup() {
  const store = new InMemoryParticipantStore();
  const stripe = fakeRefundGateway();
  const intentId = stripe.capture(CHARGE);
  const metrics = fakeMetricsPort();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const useCase = new RefundPaymentUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    store.refundRepo,
    stripe.port,
    store.idGenerator,
    metrics,
    fakePinoLogger(log),
  );
  const { refunds, refundIntent, retrieveRefund } = stripe;
  return { store, refunds, intentId, useCase, metrics, log, refundIntent, retrieveRefund };
}

function captured(context: ReturnType<typeof setup>, header: PaymentOrderStatus = PaymentOrderStatus.CAPTURED) {
  context.store.seedHeader(ORDER_ID, header);
  return context.store.seedPayment({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    status: PaymentStatus.SUCCEEDED,
    sessionId: 'cs_1',
    intentId: context.intentId,
  });
}

describe('RefundPaymentUseCase', () => {
  it('refunds a captured order in full, once, recording who asked', async () => {
    const context = setup();
    captured(context);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });

    const [refund] = context.refunds.of(context.intentId);
    expect(context.refunds.of(context.intentId)).toHaveLength(1);
    expect(refund).toMatchObject({
      amountMinor: CHARGE.amountMinor,
      metadata: { order_id: ORDER_ID, requested_by: ADMIN },
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDED);
    expect(context.store.refund(ORDER_ID)).toMatchObject({
      paymentId: PAYMENT_ID,
      providerRefundId: refund.id,
      requestedBy: ADMIN,
      amountMinor: CHARGE.amountMinor,
      currency: CHARGE.currency,
      status: PaymentRefundStatus.SUCCEEDED,
    });
    expect(context.refundIntent).toHaveBeenCalledWith(expect.anything(), `refund:${PAYMENT_ID}:0`);
  });

  it("refunds the captured attempt's amount, whatever else the order once said", async () => {
    const context = setup();
    context.store.seedHeader(ORDER_ID, PaymentOrderStatus.CAPTURED, { amountMinor: 999_999 });
    context.store.seedPayment({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      status: PaymentStatus.SUCCEEDED,
      intentId: context.intentId,
      amountMinor: 150_000,
    });

    await context.useCase.execute(ORDER_ID, ADMIN);

    expect(context.refundIntent.mock.calls[0][0]).toMatchObject({ amountMinor: 150_000, currency: 'VND' });
    expect(context.store.refund(ORDER_ID)?.amountMinor).toBe(150_000);
  });

  it.each([
    null,
    PaymentOrderStatus.OPEN,
    PaymentOrderStatus.AUTHORIZED,
    PaymentOrderStatus.CANCELLED,
    PaymentOrderStatus.FENCED,
  ])('answers NOT_REFUNDABLE on a %s header without reaching Stripe', async (header) => {
    const context = setup();
    if (header) context.store.seedHeader(ORDER_ID, header);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'NOT_REFUNDABLE' });
    expect(context.refundIntent).not.toHaveBeenCalled();
    expect(context.store.refund(ORDER_ID)).toBeUndefined();
  });

  it('answers a repeat IDEMPOTENT without reaching Stripe', async () => {
    const context = setup();
    captured(context);
    await context.useCase.execute(ORDER_ID, ADMIN);
    context.refundIntent.mockClear();

    await expect(context.useCase.execute(ORDER_ID, OTHER_ADMIN)).resolves.toEqual({ outcome: 'IDEMPOTENT' });
    expect(context.refundIntent).not.toHaveBeenCalled();
    expect(context.retrieveRefund).not.toHaveBeenCalled();
  });

  it('answers REFUND_FAILED with the reason, counting the money owed once across repeats', async () => {
    const context = setup();
    captured(context);
    context.refunds.fail(context.intentId, 'refund_fails');

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({
      outcome: 'REFUND_FAILED',
      reason: 'expired_or_canceled_card',
    });
    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({
      outcome: 'REFUND_FAILED',
      reason: 'expired_or_canceled_card',
    });

    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUND_FAILED);
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.FAILED);
    expect(context.metrics.recordRefundOwed).toHaveBeenCalledTimes(1);
    expect(context.metrics.recordRefundOwed).toHaveBeenCalledWith('refund_failed');
    expect(context.refundIntent).toHaveBeenCalledTimes(1);
  });

  it('answers PENDING while Stripe holds the refund, then REFUNDED once it settles, never creating twice', async () => {
    const context = setup();
    captured(context);
    context.refunds.fail(context.intentId, 'refund_pending');

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'PENDING' });
    const pending = context.store.refund(ORDER_ID);
    expect(pending?.status).toBe(PaymentRefundStatus.PENDING);
    expect(pending?.providerRefundId).toMatch(/^re_/);
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'PENDING' });
    context.refunds.settle(pending?.providerRefundId as string, 'succeeded');
    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });

    expect(context.refundIntent).toHaveBeenCalledTimes(1);
    expect(context.retrieveRefund).toHaveBeenCalledTimes(2);
  });

  it('resumes with the same key after Stripe applied the refund but its answer was lost, refunding once', async () => {
    const context = setup();
    captured(context);
    context.refunds.fail(context.intentId, 'timeout');

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).rejects.toBeInstanceOf(PaymentGatewayError);
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.PENDING);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });
    const keys = context.refundIntent.mock.calls.map(([, key]) => key);
    expect(keys).toEqual([`refund:${PAYMENT_ID}:0`, `refund:${PAYMENT_ID}:0`]);
    expect(context.refunds.of(context.intentId)).toHaveLength(1);
  });

  it('moves to a fresh key only after a 5xx that refunded nothing', async () => {
    const context = setup();
    captured(context);
    context.refunds.fail(context.intentId, 'server_error');

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).rejects.toMatchObject({ retryWithFreshKey: true });
    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });

    expect(context.refundIntent.mock.calls.map(([, key]) => key)).toEqual([
      `refund:${PAYMENT_ID}:0`,
      `refund:${PAYMENT_ID}:1`,
    ]);
    expect(context.refunds.of(context.intentId)).toHaveLength(1);
  });

  it('reads back a refund whose id it already recorded, never creating one', async () => {
    const context = setup();
    captured(context, PaymentOrderStatus.REFUNDING);
    const existing = context.refunds.outOfBand(context.intentId);
    context.store.seedRefund({ orderId: ORDER_ID, paymentId: PAYMENT_ID, providerRefundId: existing });

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });
    expect(context.retrieveRefund).toHaveBeenCalledWith(existing);
    expect(context.refundIntent).not.toHaveBeenCalled();
  });

  it('keeps the first admin when another resumes the refund', async () => {
    const context = setup();
    captured(context, PaymentOrderStatus.REFUNDING);
    context.store.seedRefund({ orderId: ORDER_ID, paymentId: PAYMENT_ID, requestedBy: ADMIN });

    await expect(context.useCase.execute(ORDER_ID, OTHER_ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });

    expect(context.refundIntent.mock.calls[0][0]).toMatchObject({ requestedBy: ADMIN });
    expect(context.store.refund(ORDER_ID)?.requestedBy).toBe(ADMIN);
    expect(context.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, requestedBy: OTHER_ADMIN, recordedBy: ADMIN }),
      expect.stringMatching(/another admin/),
    );
  });

  it('answers from the header when the webhook settled the refund during the Stripe call', async () => {
    const context = setup();
    captured(context);
    context.refunds.fail(context.intentId, 'refund_pending');
    context.refundIntent.mockImplementationOnce(async (input, key) => {
      const reported = await context.refunds.create(input, key);
      context.store.headers.set(ORDER_ID, { ...context.store.header(ORDER_ID)!, status: PaymentOrderStatus.REFUNDED });
      const row = context.store.refund(ORDER_ID)!;
      context.store.refunds.set(ORDER_ID, {
        ...row,
        status: PaymentRefundStatus.SUCCEEDED,
        providerRefundId: reported.refundId,
      });
      return reported;
    });

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.SUCCEEDED);
    expect(context.metrics.recordRefundOwed).not.toHaveBeenCalled();
  });

  it('adopts a full refund made outside the shop instead of refunding twice', async () => {
    const context = setup();
    captured(context);
    const dashboard = context.refunds.outOfBand(context.intentId);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });
    expect(context.refunds.of(context.intentId)).toHaveLength(1);
    expect(context.store.refund(ORDER_ID)).toMatchObject({ providerRefundId: dashboard, requestedBy: ADMIN });
    expect(context.metrics.recordRefundOwed).not.toHaveBeenCalled();
  });

  it('settles a refund adopted from several partial refunds without naming one, logging them all', async () => {
    const context = setup();
    captured(context);
    const parts = [context.refunds.outOfBand(context.intentId, 100_000)];
    parts.push(context.refunds.outOfBand(context.intentId, 50_000));

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).resolves.toEqual({ outcome: 'REFUNDED' });
    expect(context.store.refund(ORDER_ID)).toMatchObject({
      providerRefundId: null,
      coveredRefundIds: parts,
      status: 'SUCCEEDED',
    });
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, refundIds: parts }),
      expect.stringMatching(/several refunds/),
    );
  });

  it('refuses to settle a refund Stripe reports for another intent', async () => {
    const context = setup();
    captured(context);
    context.refundIntent.mockResolvedValueOnce({
      refundId: 're_x',
      intentId: 'pi_someone_else',
      metadataOrderId: null,
      amountMinor: CHARGE.amountMinor,
      currency: 'vnd',
      status: 'succeeded',
      failureReason: null,
    });

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).rejects.toThrow(/does not match/);
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.PENDING);
  });

  it('leaves the header REFUNDING and nothing settled when Stripe is down', async () => {
    const context = setup();
    captured(context);
    context.refunds.failCalls(context.intentId);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).rejects.toBeInstanceOf(PaymentGatewayError);
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)).toMatchObject({
      status: PaymentRefundStatus.PENDING,
      providerRefundId: null,
    });
  });

  it('refuses a captured header with no captured attempt rather than guessing an amount', async () => {
    const context = setup();
    context.store.seedHeader(ORDER_ID, PaymentOrderStatus.CAPTURED);

    await expect(context.useCase.execute(ORDER_ID, ADMIN)).rejects.toThrow(/no captured payment/);
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
  });
});
