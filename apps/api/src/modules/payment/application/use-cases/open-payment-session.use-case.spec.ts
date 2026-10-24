import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import type { PaymentGatewayPort, SessionAuthorization } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { CHARGE, InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { OpenPaymentSessionUseCase } from './open-payment-session.use-case';
import { RecordAuthorizationUseCase } from './record-authorization.use-case';

const ORDER_ID = '7001';
const MIN_LEAD_SEC = 1_800 + 120;
const NEW_SESSION = 'cs_new';

function setup() {
  const store = new InMemoryParticipantStore();
  const createSession = vi
    .fn<PaymentGatewayPort['createSession']>()
    .mockResolvedValue({ providerSessionId: NEW_SESSION, redirectUrl: `https://pay.test/${NEW_SESSION}` });
  const expireSession = vi.fn<PaymentGatewayPort['expireSession']>().mockResolvedValue('expired');
  const retrieveAuthorization = vi.fn<PaymentGatewayPort['retrieveAuthorization']>();
  const voidIntent = vi.fn<PaymentGatewayPort['voidIntent']>().mockResolvedValue('voided');
  const gateway = fakePaymentGateway({ createSession, expireSession, retrieveAuthorization, voidIntent });
  const logger = fakePinoLogger();
  const recordAuthorization = new RecordAuthorizationUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    gateway,
    store.outboxWriter,
    store.idGenerator,
    fakeMetricsPort(),
    logger,
  );
  const useCase = new OpenPaymentSessionUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    gateway,
    recordAuthorization,
    store.idGenerator,
    fakeConfigService({ 'payment.sessionMinTtlSec': 1_800, 'payment.sessionExpiryMarginSec': 120 }),
    logger,
  );
  return { store, useCase, createSession, expireSession, retrieveAuthorization };
}

function input(overrides: { amountMinor?: number; expiresAt?: Date } = {}) {
  return {
    orderId: ORDER_ID,
    amountMinor: overrides.amountMinor ?? CHARGE.amountMinor,
    currency: CHARGE.currency,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + (MIN_LEAD_SEC + 600) * 1_000),
  };
}

/** Header OPEN with a PENDING attempt on session `cs_old`. */
function withOpenAttempt(store: InMemoryParticipantStore) {
  store.seedHeader(ORDER_ID, PaymentOrderStatus.OPEN);
  return store.seedPayment({ id: '8001', orderId: ORDER_ID, status: PaymentStatus.PENDING, sessionId: 'cs_old' });
}

describe('OpenPaymentSessionUseCase', () => {
  it('opens the header and a manual-capture session that dies at the given deadline', async () => {
    const { store, useCase, createSession } = setup();
    const request = input();

    const result = await useCase.execute(request);

    expect(result).toEqual({
      outcome: 'OPENED',
      paymentId: '9000',
      providerSessionId: NEW_SESSION,
      redirectUrl: `https://pay.test/${NEW_SESSION}`,
      clientSecret: undefined,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMethod: 'manual',
        expiresAt: request.expiresAt,
        idempotencyKey: expect.any(String) as unknown,
      }),
    );
    expect(store.header(ORDER_ID)).toMatchObject({ status: PaymentOrderStatus.OPEN, ...CHARGE });
    expect(store.payment('9000')).toMatchObject({ status: PaymentStatus.PENDING, providerSessionId: NEW_SESSION });
  });

  it('refuses a deadline Stripe would not accept, before touching anything', async () => {
    const { store, useCase, createSession } = setup();

    const result = await useCase.execute(input({ expiresAt: new Date(Date.now() + (MIN_LEAD_SEC - 1) * 1_000) }));

    expect(result).toEqual({ outcome: 'CLOSED' });
    expect(store.header(ORDER_ID)).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses a charge other than the one the header locked in', async () => {
    const { store, useCase, createSession } = setup();
    store.seedHeader(ORDER_ID, PaymentOrderStatus.OPEN);

    await expect(useCase.execute(input({ amountMinor: CHARGE.amountMinor + 1 }))).resolves.toEqual({
      outcome: 'CLOSED',
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    PaymentOrderStatus.AUTHORIZED,
    PaymentOrderStatus.CAPTURED,
    PaymentOrderStatus.CANCELLED,
    PaymentOrderStatus.FENCED,
  ])('opens nothing under a %s header', async (status) => {
    const { store, useCase, createSession } = setup();
    store.seedHeader(ORDER_ID, status);

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('hands back the session that is still open instead of opening another', async () => {
    const { store, useCase, createSession, retrieveAuthorization } = setup();
    withOpenAttempt(store);
    retrieveAuthorization.mockResolvedValue({ sessionStatus: 'open', redirectUrl: 'https://pay.test/cs_old' });

    await expect(useCase.execute(input())).resolves.toMatchObject({
      outcome: 'OPENED',
      paymentId: '8001',
      providerSessionId: 'cs_old',
      redirectUrl: 'https://pay.test/cs_old',
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('records a hold the probe finds, and opens nothing more', async () => {
    const { store, useCase, createSession, retrieveAuthorization } = setup();
    withOpenAttempt(store);
    retrieveAuthorization.mockResolvedValue({
      sessionStatus: 'complete',
      intentId: 'pi_1',
      intentStatus: 'requires_capture',
      amountCapturableMinor: CHARGE.amountMinor,
      currency: 'vnd',
    });

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });

    expect(store.payment('8001').status).toBe(PaymentStatus.AUTHORIZED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.AUTHORIZED);
    expect(store.outbox.map(({ record }) => record.eventType)).toEqual(['payment.authorized']);
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each<SessionAuthorization>([
    { sessionStatus: 'complete', intentId: 'pi_1', intentStatus: 'processing' },
    { sessionStatus: 'unknown' },
  ])('opens nothing while the probe cannot prove the attempt dead ($sessionStatus)', async (probe) => {
    const { store, useCase, createSession, retrieveAuthorization } = setup();
    withOpenAttempt(store);
    retrieveAuthorization.mockResolvedValue(probe);

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });
    expect(store.payment('8001').status).toBe(PaymentStatus.PENDING);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('retires an attempt whose session expired and opens a fresh one', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    withOpenAttempt(store);
    retrieveAuthorization.mockResolvedValue({ sessionStatus: 'expired' });

    await expect(useCase.execute(input())).resolves.toMatchObject({
      outcome: 'OPENED',
      providerSessionId: NEW_SESSION,
    });

    expect(store.payment('8001').status).toBe(PaymentStatus.EXPIRED);
    expect(store.payment('9000').status).toBe(PaymentStatus.PENDING);
  });

  it('closes the session it just made when a cancel lands during the round-trip', async () => {
    const { store, useCase, createSession, expireSession } = setup();
    createSession.mockImplementationOnce(() => {
      store.seedHeader(ORDER_ID, PaymentOrderStatus.CANCELLED);
      return Promise.resolve({ providerSessionId: NEW_SESSION });
    });

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });

    expect(expireSession).toHaveBeenCalledWith(NEW_SESSION);
    expect(store.byOrder(ORDER_ID)).toEqual([]);
  });

  it('closes the session it just made when another attempt became active meanwhile', async () => {
    const { store, useCase, createSession, expireSession } = setup();
    createSession.mockImplementationOnce(() => {
      store.seedPayment({ id: '8002', orderId: ORDER_ID, status: PaymentStatus.PENDING, sessionId: 'cs_other' });
      return Promise.resolve({ providerSessionId: NEW_SESSION });
    });

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });

    expect(expireSession).toHaveBeenCalledWith(NEW_SESSION);
    expect(store.byOrder(ORDER_ID).map((p) => p.id)).toEqual(['8002']);
  });

  it('still answers CLOSED when the stranded session cannot be closed', async () => {
    const { store, useCase, createSession, expireSession } = setup();
    createSession.mockImplementationOnce(() => {
      store.seedHeader(ORDER_ID, PaymentOrderStatus.CANCELLED);
      return Promise.resolve({ providerSessionId: NEW_SESSION });
    });
    expireSession.mockRejectedValueOnce(new Error('stripe down'));

    await expect(useCase.execute(input())).resolves.toEqual({ outcome: 'CLOSED' });
  });

  it('lets a gateway failure through with nothing written past the header', async () => {
    const { store, useCase, createSession } = setup();
    createSession.mockRejectedValueOnce(new Error('stripe down'));

    await expect(useCase.execute(input())).rejects.toThrow('stripe down');
    expect(store.byOrder(ORDER_ID)).toEqual([]);
  });
});
