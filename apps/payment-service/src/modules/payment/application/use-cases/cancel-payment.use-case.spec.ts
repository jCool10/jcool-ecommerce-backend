import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentGatewayError, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { CancelPaymentUseCase } from './cancel-payment.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';
const SESSION_ID = 'cs_1';
const INTENT_ID = 'pi_1';

function setup() {
  const store = new InMemoryParticipantStore();
  const expireSession = vi.fn<PaymentGatewayPort['expireSession']>().mockResolvedValue('expired');
  const retrieveAuthorization = vi.fn<PaymentGatewayPort['retrieveAuthorization']>();
  const voidIntent = vi.fn<PaymentGatewayPort['voidIntent']>().mockResolvedValue('voided');
  const metrics = fakeMetricsPort();
  const useCase = new CancelPaymentUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    fakePaymentGateway({ expireSession, retrieveAuthorization, voidIntent }),
    metrics,
    fakePinoLogger(),
  );
  return { store, useCase, expireSession, retrieveAuthorization, voidIntent, metrics };
}

function seed(store: InMemoryParticipantStore, header: PaymentOrderStatus, payment?: PaymentStatus) {
  store.seedHeader(ORDER_ID, header);
  if (payment) {
    store.seedPayment({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      status: payment,
      sessionId: SESSION_ID,
      intentId: payment === PaymentStatus.PENDING ? null : INTENT_ID,
    });
  }
}

const HELD = {
  sessionStatus: 'complete',
  intentId: INTENT_ID,
  intentStatus: 'requires_capture',
  amountCapturableMinor: 150_000,
  currency: 'vnd',
} as const;

describe('CancelPaymentUseCase', () => {
  it('fences an order that never opened, with no charge on the header', async () => {
    const { store, useCase, expireSession } = setup();

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('FENCED');

    expect(store.header(ORDER_ID)).toMatchObject({
      status: PaymentOrderStatus.FENCED,
      amountMinor: null,
      currency: null,
    });
    expect(expireSession).not.toHaveBeenCalled();
  });

  it('commits the flip before calling Stripe, then expires the open session', async () => {
    const { store, useCase, expireSession } = setup();
    seed(store, PaymentOrderStatus.OPEN, PaymentStatus.PENDING);
    expireSession.mockImplementationOnce(() => {
      expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);
      expect(store.transactions).toBe(1);
      return Promise.resolve('expired');
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CANCELLED');

    expect(expireSession).toHaveBeenCalledWith(SESSION_ID);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.EXPIRED);
  });

  it('voids an authorized hold under its current key', async () => {
    const { store, useCase, voidIntent } = setup();
    seed(store, PaymentOrderStatus.AUTHORIZED, PaymentStatus.AUTHORIZED);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CANCELLED');

    expect(voidIntent).toHaveBeenCalledWith(INTENT_ID, `void:${PAYMENT_ID}:0`);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);
  });

  it('reports a captured order as a conflict without calling Stripe', async () => {
    const { store, useCase, voidIntent, metrics } = setup();
    seed(store, PaymentOrderStatus.CAPTURED, PaymentStatus.SUCCEEDED);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CAPTURED_CONFLICT');

    expect(voidIntent).not.toHaveBeenCalled();
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
  });

  it('voids the hold of a session the buyer completed before the expire reached it', async () => {
    const { store, useCase, retrieveAuthorization, expireSession, voidIntent } = setup();
    seed(store, PaymentOrderStatus.OPEN, PaymentStatus.PENDING);
    expireSession.mockResolvedValueOnce('already_completed');
    retrieveAuthorization.mockResolvedValueOnce(HELD);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CANCELLED');

    expect(voidIntent).toHaveBeenCalledWith(INTENT_ID, `void:${PAYMENT_ID}:0`);
    expect(store.payment(PAYMENT_ID)).toMatchObject({ status: PaymentStatus.VOIDED, providerIntentId: INTENT_ID });
  });

  it('still voids when the authorization webhook commits between the two transactions', async () => {
    const { store, useCase, retrieveAuthorization, expireSession } = setup();
    seed(store, PaymentOrderStatus.OPEN, PaymentStatus.PENDING);
    expireSession.mockImplementationOnce(() => {
      store.setPaymentStatus(PAYMENT_ID, PaymentStatus.AUTHORIZED, INTENT_ID);
      return Promise.resolve('already_completed');
    });
    retrieveAuthorization.mockResolvedValueOnce(HELD);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CANCELLED');

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);
  });

  it('records a hold Stripe already cancelled as voided', async () => {
    const { store, useCase, retrieveAuthorization, expireSession, voidIntent } = setup();
    seed(store, PaymentOrderStatus.OPEN, PaymentStatus.PENDING);
    expireSession.mockResolvedValueOnce('already_completed');
    retrieveAuthorization.mockResolvedValueOnce({ ...HELD, intentStatus: 'canceled' });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CANCELLED');

    expect(voidIntent).not.toHaveBeenCalled();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
  });

  it('throws while a completed session is still settling, leaving the header flipped for the retry', async () => {
    const { store, useCase, retrieveAuthorization, expireSession } = setup();
    seed(store, PaymentOrderStatus.OPEN, PaymentStatus.PENDING);
    expireSession.mockResolvedValueOnce('already_completed');
    retrieveAuthorization.mockResolvedValueOnce({ ...HELD, intentStatus: 'processing' });

    await expect(useCase.execute(ORDER_ID)).rejects.toThrow();

    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.PENDING);
  });

  it('rescans an already cancelled order and voids what is left, answering IDEMPOTENT', async () => {
    const { store, useCase, voidIntent } = setup();
    seed(store, PaymentOrderStatus.CANCELLED, PaymentStatus.AUTHORIZED);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('IDEMPOTENT');

    expect(voidIntent).toHaveBeenCalledOnce();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
  });

  it('answers IDEMPOTENT for a fenced order with nothing to release', async () => {
    const { store, useCase } = setup();
    seed(store, PaymentOrderStatus.FENCED);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('IDEMPOTENT');
  });

  it('books the capture and reports a conflict when the void finds the money already taken', async () => {
    const { store, useCase, voidIntent, metrics } = setup();
    seed(store, PaymentOrderStatus.AUTHORIZED, PaymentStatus.AUTHORIZED);
    voidIntent.mockResolvedValueOnce('already_captured');

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CAPTURED_CONFLICT');

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.SUCCEEDED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
  });

  it('rotates the void key after a 5xx Stripe provably did not apply', async () => {
    const { store, useCase, voidIntent } = setup();
    seed(store, PaymentOrderStatus.AUTHORIZED, PaymentStatus.AUTHORIZED);
    voidIntent.mockRejectedValueOnce(new PaymentGatewayError('stored 500', undefined, { retryWithFreshKey: true }));

    await expect(useCase.execute(ORDER_ID)).rejects.toThrow(PaymentGatewayError);
    expect(store.payment(PAYMENT_ID)).toMatchObject({ status: PaymentStatus.AUTHORIZED, stripeKeyGen: 1 });
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('IDEMPOTENT');
    expect(voidIntent).toHaveBeenLastCalledWith(INTENT_ID, `void:${PAYMENT_ID}:1`);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
  });
});
