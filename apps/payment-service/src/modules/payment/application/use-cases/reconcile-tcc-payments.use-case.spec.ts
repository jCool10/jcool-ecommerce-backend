import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentGatewayError, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { CancelPaymentUseCase } from './cancel-payment.use-case';
import { RecordAuthorizationUseCase } from './record-authorization.use-case';
import { ReconcileTccPaymentsUseCase } from './reconcile-tcc-payments.use-case';

const SWEEP = { staleAfterSec: 60, batchSize: 50 };

function setup() {
  const store = new InMemoryParticipantStore();
  const retrieveAuthorization = vi.fn<PaymentGatewayPort['retrieveAuthorization']>();
  const voidIntent = vi.fn<PaymentGatewayPort['voidIntent']>().mockResolvedValue('voided');
  const gateway = fakePaymentGateway({ retrieveAuthorization, voidIntent });
  const metrics = fakeMetricsPort();
  const logger = fakePinoLogger();
  const record = new RecordAuthorizationUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    gateway,
    store.outboxWriter,
    store.idGenerator,
    metrics,
    logger,
  );
  const cancel = new CancelPaymentUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    gateway,
    metrics,
    logger,
  );
  const useCase = new ReconcileTccPaymentsUseCase(store.paymentRepo, gateway, record, cancel, logger);
  return { store, useCase, retrieveAuthorization, voidIntent };
}

function pendingUnderOpen(store: InMemoryParticipantStore, orderId: string, paymentId: string) {
  store.seedHeader(orderId, PaymentOrderStatus.OPEN);
  return store.seedPayment({ id: paymentId, orderId, status: PaymentStatus.PENDING, sessionId: `cs_${paymentId}` });
}

describe('ReconcileTccPaymentsUseCase', () => {
  it('asks the repository for stale participant payments only', async () => {
    const { store, useCase } = setup();
    const findStaleTcc = vi.spyOn(store.paymentRepo, 'findStaleTcc');

    await useCase.execute(SWEEP);

    expect(findStaleTcc).toHaveBeenCalledWith({ updatedBefore: expect.any(Date) as unknown, limit: 50 });
    const cutoff = findStaleTcc.mock.calls[0][0].updatedBefore.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(60_000);
  });

  it('records a hold the webhook never delivered', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    retrieveAuthorization.mockResolvedValue({
      sessionStatus: 'complete',
      intentId: 'pi_1',
      intentStatus: 'requires_capture',
      amountCapturableMinor: 150_000,
      currency: 'vnd',
    });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ scanned: 1, recorded: 1 });

    expect(store.payment('8001').status).toBe(PaymentStatus.AUTHORIZED);
    expect(store.outbox.map(({ record }) => record.eventType)).toEqual(['payment.authorized']);
  });

  it('sends a hold it could not record to the back of the queue instead of counting it recorded', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    pendingUnderOpen(store, '7002', '8002');
    retrieveAuthorization.mockResolvedValue({
      sessionStatus: 'complete',
      intentId: 'pi_1',
      intentStatus: 'requires_capture',
      amountCapturableMinor: 1,
      currency: 'vnd',
    });

    await expect(useCase.execute({ ...SWEEP, batchSize: 1 })).resolves.toMatchObject({ recorded: 0, deferred: 1 });

    expect(store.payment('8001').status).toBe(PaymentStatus.PENDING);
    const queue = await store.paymentRepo.findStaleTcc({ updatedBefore: new Date(), limit: 2 });
    expect(queue.map((p) => p.id)).toEqual(['8002', '8001']);
  });

  it('retires an attempt whose session expired', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    retrieveAuthorization.mockResolvedValue({ sessionStatus: 'expired' });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ expired: 1 });
    expect(store.payment('8001').status).toBe(PaymentStatus.EXPIRED);
  });

  it('marks an attempt voided when Stripe already let its hold go', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    retrieveAuthorization.mockResolvedValue({ sessionStatus: 'complete', intentId: 'pi_1', intentStatus: 'canceled' });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ voided: 1 });
    expect(store.payment('8001')).toMatchObject({ status: PaymentStatus.VOIDED, providerIntentId: 'pi_1' });
  });

  it('sends an attempt with nothing to report to the back of the queue, recording nothing', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    pendingUnderOpen(store, '7002', '8002');
    retrieveAuthorization.mockResolvedValue({ sessionStatus: 'open' });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ deferred: 2 });

    expect(store.payment('8001').status).toBe(PaymentStatus.PENDING);
    expect(store.header('7001')?.authorizedAt).toBeNull();
    const queue = await store.paymentRepo.findStaleTcc({ updatedBefore: new Date(), limit: 2 });
    expect(queue.map((p) => p.id)).toEqual(['8001', '8002']);
    // A one-payment sweep sends the head of the queue behind the rest.
    await useCase.execute({ ...SWEEP, batchSize: 1 });
    const next = await store.paymentRepo.findStaleTcc({ updatedBefore: new Date(), limit: 2 });
    expect(next.map((p) => p.id)).toEqual(['8002', '8001']);
  });

  it('voids a hold left under a cancelled order', async () => {
    const { store, useCase, voidIntent } = setup();
    store.seedHeader('7001', PaymentOrderStatus.CANCELLED, { authorizedAt: new Date() });
    store.seedPayment({ id: '8001', orderId: '7001', status: PaymentStatus.AUTHORIZED, intentId: 'pi_1' });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ voided: 1 });

    expect(voidIntent).toHaveBeenCalledWith('pi_1', 'void:8001:0');
    expect(store.payment('8001').status).toBe(PaymentStatus.VOIDED);
  });

  it('keeps going past a payment that fails', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    pendingUnderOpen(store, '7001', '8001');
    pendingUnderOpen(store, '7002', '8002');
    retrieveAuthorization
      .mockRejectedValueOnce(new PaymentGatewayError('breaker open'))
      .mockResolvedValueOnce({ sessionStatus: 'expired' });

    await expect(useCase.execute(SWEEP)).resolves.toMatchObject({ scanned: 2, errors: 1, expired: 1 });
    expect(store.payment('8002').status).toBe(PaymentStatus.EXPIRED);
  });
});
