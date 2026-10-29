import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentGatewayError, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { CapturePaymentUseCase } from './capture-payment.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';
const INTENT_ID = 'pi_1';

function setup(header: PaymentOrderStatus | null = PaymentOrderStatus.AUTHORIZED) {
  const store = new InMemoryParticipantStore();
  if (header) store.seedHeader(ORDER_ID, header, { authorizedAt: new Date() });
  if (header !== null && header !== PaymentOrderStatus.OPEN) {
    store.seedPayment({ id: PAYMENT_ID, orderId: ORDER_ID, status: PaymentStatus.AUTHORIZED, intentId: INTENT_ID });
  }
  const captureIntent = vi.fn<PaymentGatewayPort['captureIntent']>().mockResolvedValue({ kind: 'captured' });
  const metrics = fakeMetricsPort();
  const useCase = new CapturePaymentUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    fakePaymentGateway({ captureIntent }),
    metrics,
    fakePinoLogger(),
  );
  return { store, useCase, captureIntent, metrics };
}

describe('CapturePaymentUseCase', () => {
  it("captures the hold under the payment's current key and closes both rows", async () => {
    const { store, useCase, captureIntent } = setup();

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CAPTURED');

    expect(captureIntent).toHaveBeenCalledWith(INTENT_ID, `capture:${PAYMENT_ID}:0`);
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.SUCCEEDED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
  });

  it('answers a repeat as IDEMPOTENT without calling Stripe', async () => {
    const { store, useCase, captureIntent } = setup();
    await useCase.execute(ORDER_ID);

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('IDEMPOTENT');
    expect(captureIntent).toHaveBeenCalledOnce();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.SUCCEEDED);
  });

  it.each([null, PaymentOrderStatus.OPEN])(
    'answers CONFLICT when nothing was authorized yet (header %s)',
    async (header) => {
      const { useCase, captureIntent } = setup(header);

      await expect(useCase.execute(ORDER_ID)).resolves.toBe('CONFLICT');
      expect(captureIntent).not.toHaveBeenCalled();
    },
  );

  it.each([PaymentOrderStatus.CANCELLED, PaymentOrderStatus.FENCED])(
    'answers NOT_CAPTURABLE under a %s header without calling Stripe',
    async (header) => {
      const { useCase, captureIntent } = setup(header);

      await expect(useCase.execute(ORDER_ID)).resolves.toBe('NOT_CAPTURABLE');
      expect(captureIntent).not.toHaveBeenCalled();
    },
  );

  // A timeout or a 409 says nothing about whether Stripe applied it: same key next time.
  it('lets an unknown outcome through and leaves the payment and its key alone', async () => {
    const { store, useCase, captureIntent } = setup();
    captureIntent.mockRejectedValueOnce(new PaymentGatewayError('idempotency request in flight'));

    await expect(useCase.execute(ORDER_ID)).rejects.toThrow(PaymentGatewayError);

    expect(store.payment(PAYMENT_ID)).toMatchObject({ status: PaymentStatus.AUTHORIZED, stripeKeyGen: 0 });
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.AUTHORIZED);
  });

  it('fails the payment and cancels the header once the hold is gone', async () => {
    const { store, useCase, captureIntent } = setup();
    captureIntent.mockResolvedValueOnce({ kind: 'not_capturable', intentStatus: 'canceled' });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('NOT_CAPTURABLE');

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.FAILED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CANCELLED);
  });

  it('rotates the key after a 5xx Stripe provably did not apply, and the retry uses the new one', async () => {
    const { store, useCase, captureIntent } = setup();
    captureIntent.mockRejectedValueOnce(new PaymentGatewayError('stored 500', undefined, { retryWithFreshKey: true }));

    await expect(useCase.execute(ORDER_ID)).rejects.toThrow(PaymentGatewayError);
    expect(store.payment(PAYMENT_ID)).toMatchObject({ status: PaymentStatus.AUTHORIZED, stripeKeyGen: 1 });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CAPTURED');
    expect(captureIntent).toHaveBeenLastCalledWith(INTENT_ID, `capture:${PAYMENT_ID}:1`);
  });

  // The money moved; the books follow the money and a human sorts out the cancelled order.
  it('records the capture even when a cancel flipped the header during the round-trip', async () => {
    const { store, useCase, captureIntent, metrics } = setup();
    captureIntent.mockImplementationOnce(() => {
      store.seedHeader(ORDER_ID, PaymentOrderStatus.CANCELLED, { authorizedAt: new Date() });
      return Promise.resolve({ kind: 'captured' });
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('CAPTURED');

    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.SUCCEEDED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
    expect(metrics.recordCaptureConflict).toHaveBeenCalledOnce();
  });

  it('answers IDEMPOTENT when a concurrent capture committed first', async () => {
    const { store, useCase, captureIntent } = setup();
    captureIntent.mockImplementationOnce(() => {
      store.setPaymentStatus(PAYMENT_ID, PaymentStatus.SUCCEEDED);
      store.seedHeader(ORDER_ID, PaymentOrderStatus.CAPTURED, { authorizedAt: new Date() });
      return Promise.resolve({ kind: 'captured' });
    });

    await expect(useCase.execute(ORDER_ID)).resolves.toBe('IDEMPOTENT');
  });
});
