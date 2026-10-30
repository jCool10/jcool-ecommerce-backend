import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentGatewayError, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { RecordAuthorizationUseCase, WebhookRetryLaterError } from './record-authorization.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';
const INTENT_ID = 'pi_1';
const AUTHORIZED_AT = new Date('2026-10-20T10:00:00.000Z');
const HOLD = { intentId: INTENT_ID, amountMinor: 150_000, currency: 'vnd' };

function setup(header: PaymentOrderStatus = PaymentOrderStatus.OPEN, payment: PaymentStatus = PaymentStatus.PENDING) {
  const store = new InMemoryParticipantStore();
  store.seedHeader(ORDER_ID, header);
  store.seedPayment({ id: PAYMENT_ID, orderId: ORDER_ID, status: payment });
  const voidIntent = vi.fn<PaymentGatewayPort['voidIntent']>().mockResolvedValue('voided');
  const metrics = fakeMetricsPort();
  const useCase = new RecordAuthorizationUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    fakePaymentGateway({ voidIntent }),
    store.outboxWriter,
    store.idGenerator,
    metrics,
    fakePinoLogger(),
  );
  return { store, useCase, voidIntent, metrics };
}

describe('RecordAuthorizationUseCase', () => {
  it('records the hold of the current attempt once, under the outbox id minted before the transaction', async () => {
    const { store, useCase, metrics } = setup();

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).resolves.toBe('recorded');

    expect(store.payment(PAYMENT_ID)).toMatchObject({ status: PaymentStatus.AUTHORIZED, providerIntentId: INTENT_ID });
    expect(store.header(ORDER_ID)).toMatchObject({
      status: PaymentOrderStatus.AUTHORIZED,
      authorizedAt: AUTHORIZED_AT,
    });
    expect(store.outbox).toEqual([
      {
        id: '9000',
        record: expect.objectContaining({
          eventType: 'payment.authorized',
          aggregateId: PAYMENT_ID,
          payload: {
            paymentId: PAYMENT_ID,
            orderId: ORDER_ID,
            amountMinor: 150_000,
            currency: 'VND',
            authorizedAt: AUTHORIZED_AT.toISOString(),
          },
        }) as unknown,
      },
    ]);
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'record_authorization', 'recorded');
  });

  // The cancel already expired the session, but the buyer got through first: the money is real, so
  // the event still goes out and the saga voids it.
  it('records a hold that lands after the order was cancelled, leaving the header cancelled', async () => {
    const { store, useCase } = setup(PaymentOrderStatus.CANCELLED);

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).resolves.toBe('recorded_late');

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.AUTHORIZED);
    expect(store.header(ORDER_ID)).toMatchObject({ status: PaymentOrderStatus.CANCELLED, authorizedAt: AUTHORIZED_AT });
    expect(store.outbox).toHaveLength(1);
  });

  it('writes nothing for a hold it already recorded', async () => {
    const { store, useCase, voidIntent } = setup(PaymentOrderStatus.AUTHORIZED, PaymentStatus.AUTHORIZED);

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).resolves.toBe('already_recorded');

    expect(store.outbox).toEqual([]);
    expect(voidIntent).not.toHaveBeenCalled();
  });

  // Reconcile and the open probe hold their read across a Stripe round-trip, and the webhook can
  // record the same hold meanwhile. That hold is the order's own, not a stray.
  it('decides on a fresh read, so a hold recorded since the caller read the payment is never voided', async () => {
    const { store, useCase, voidIntent } = setup();
    const snapshot = store.payment(PAYMENT_ID);
    await useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT);

    await expect(useCase.record(snapshot, HOLD, AUTHORIZED_AT)).resolves.toBe('already_recorded');

    expect(voidIntent).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(1);
  });

  it('writes nothing for a hold whose amount is not the order total', async () => {
    const { store, useCase } = setup();

    await expect(useCase.record(store.payment(PAYMENT_ID), { ...HOLD, amountMinor: 1 }, AUTHORIZED_AT)).resolves.toBe(
      'amount_mismatch',
    );

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.PENDING);
    expect(store.header(ORDER_ID)).toMatchObject({ status: PaymentOrderStatus.OPEN, authorizedAt: null });
    expect(store.outbox).toEqual([]);
  });

  it('voids the hold of a retired attempt before any transaction and emits nothing', async () => {
    const { store, useCase, voidIntent } = setup(PaymentOrderStatus.OPEN, PaymentStatus.EXPIRED);

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).resolves.toBe('stray_voided');

    expect(voidIntent).toHaveBeenCalledOnce();
    expect(voidIntent).toHaveBeenCalledWith(INTENT_ID, `void:${PAYMENT_ID}:0`);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.EXPIRED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.OPEN);
    expect(store.outbox).toEqual([]);
  });

  it('moves the void key on when Stripe provably did not apply the stray void', async () => {
    const { store, useCase, voidIntent } = setup(PaymentOrderStatus.OPEN, PaymentStatus.EXPIRED);
    voidIntent.mockRejectedValueOnce(new PaymentGatewayError('stored 500', undefined, { retryWithFreshKey: true }));

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).rejects.toThrow(PaymentGatewayError);

    expect(store.payment(PAYMENT_ID).stripeKeyGen).toBe(1);
  });

  // prepare read the payment PENDING; by the time apply locks it, the attempt was retired. Nothing
  // voided this hold yet, so the whole delivery has to come back later.
  it('rolls back and asks for a retry when the hold only turns stray under the lock', async () => {
    const { store, useCase, voidIntent } = setup();
    const prepared = await useCase.prepare(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT);
    store.setPaymentStatus(PAYMENT_ID, PaymentStatus.EXPIRED);

    await expect(store.txRunner.run((tx) => useCase.apply(tx, prepared))).rejects.toThrow(WebhookRetryLaterError);

    expect(voidIntent).not.toHaveBeenCalled();
    expect(store.header(ORDER_ID)).toMatchObject({ status: PaymentOrderStatus.OPEN, authorizedAt: null });
    expect(store.outbox).toEqual([]);
  });

  it('counts a failed record as an error', async () => {
    const { store, useCase, voidIntent, metrics } = setup(PaymentOrderStatus.OPEN, PaymentStatus.EXPIRED);
    voidIntent.mockRejectedValueOnce(new PaymentGatewayError('timeout'));

    await expect(useCase.record(store.payment(PAYMENT_ID), HOLD, AUTHORIZED_AT)).rejects.toThrow();

    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'record_authorization', 'error');
  });
});
