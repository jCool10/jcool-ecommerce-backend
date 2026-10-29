import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import { PaymentGatewayError, type PaymentGatewayPort, type VerifiedEvent } from '../ports/payment-gateway.port';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import { InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { ProcessTccWebhookEventUseCase } from './process-tcc-webhook-event.use-case';
import { RecordAuthorizationUseCase } from './record-authorization.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';
const SESSION_ID = 'cs_1';

const HELD = {
  sessionStatus: 'complete',
  intentId: 'pi_1',
  intentStatus: 'requires_capture',
  amountCapturableMinor: 150_000,
  currency: 'vnd',
} as const;

function event(type: string, providerEventId = 'evt_1'): Extract<VerifiedEvent, { kind: 'valid' }> {
  return {
    kind: 'valid',
    providerEventId,
    type,
    payload: { data: { object: { id: SESSION_ID, payment_status: 'unpaid' } } },
  };
}

function fakeWebhookEvents() {
  const seen = new Set<string>();
  const insertIfNew = vi.fn<WebhookEventRepositoryPort['insertIfNew']>((input) => {
    const inserted = !seen.has(input.providerEventId);
    seen.add(input.providerEventId);
    const row = WebhookEvent.rehydrate({
      id: input.id ?? 'unminted',
      provider: input.provider,
      providerEventId: input.providerEventId,
      type: input.type,
      payload: input.payload,
      status: 'RECEIVED',
      receivedAt: new Date(),
      processedAt: null,
    });
    return Promise.resolve({ inserted, event: row });
  });
  return {
    insertIfNew,
    markProcessed: vi.fn<WebhookEventRepositoryPort['markProcessed']>().mockResolvedValue(undefined),
    markSkipped: vi.fn<WebhookEventRepositoryPort['markSkipped']>().mockResolvedValue(undefined),
    deleteReceivedBefore: vi.fn<WebhookEventRepositoryPort['deleteReceivedBefore']>(),
  };
}

function setup(withHeader = true) {
  const store = new InMemoryParticipantStore();
  if (withHeader) store.seedHeader(ORDER_ID, PaymentOrderStatus.OPEN);
  store.seedPayment({ id: PAYMENT_ID, orderId: ORDER_ID, status: PaymentStatus.PENDING, sessionId: SESSION_ID });
  const retrieveAuthorization = vi.fn<PaymentGatewayPort['retrieveAuthorization']>().mockResolvedValue(HELD);
  const gateway = fakePaymentGateway({ retrieveAuthorization });
  const webhookEvents = fakeWebhookEvents();
  const metrics = fakeMetricsPort();
  const record = new RecordAuthorizationUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    gateway,
    store.outboxWriter,
    store.idGenerator,
    metrics,
    fakePinoLogger(),
  );
  const useCase = new ProcessTccWebhookEventUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    webhookEvents,
    gateway,
    record,
    store.idGenerator,
  );
  return { store, useCase, retrieveAuthorization, webhookEvents, metrics };
}

describe('ProcessTccWebhookEventUseCase', () => {
  it('leaves a payment without a header to the legacy path', async () => {
    const { useCase, retrieveAuthorization, webhookEvents } = setup(false);

    await expect(useCase.execute(event('checkout.session.completed'))).resolves.toBeNull();
    expect(retrieveAuthorization).not.toHaveBeenCalled();
    expect(webhookEvents.insertIfNew).not.toHaveBeenCalled();
  });

  it('leaves event types it does not act on to the legacy path', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(event('payment_intent.succeeded'))).resolves.toBeNull();
  });

  it('records the hold Stripe confirms, logging the event under an id minted before the transaction', async () => {
    const { store, useCase, webhookEvents, metrics } = setup();

    await expect(useCase.execute(event('checkout.session.completed'))).resolves.toMatchObject({
      path: 'tcc',
      outcome: 'processed',
      orderId: ORDER_ID,
    });

    expect(webhookEvents.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) as unknown }),
      expect.anything(),
    );
    expect(webhookEvents.markProcessed).toHaveBeenCalledOnce();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.AUTHORIZED);
    expect(store.outbox.map(({ record }) => record.eventType)).toEqual(['payment.authorized']);
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'record_authorization', 'recorded');
  });

  it('answers a redelivery as a duplicate and emits nothing more', async () => {
    const { store, useCase } = setup();
    await useCase.execute(event('checkout.session.completed'));

    await expect(useCase.execute(event('checkout.session.completed'))).resolves.toMatchObject({ outcome: 'duplicate' });
    expect(store.outbox).toHaveLength(1);
  });

  it('logs nothing when Stripe cannot be asked, so the redelivery gets a clean run', async () => {
    const { useCase, retrieveAuthorization, webhookEvents } = setup();
    retrieveAuthorization.mockRejectedValueOnce(new PaymentGatewayError('breaker open'));

    await expect(useCase.execute(event('checkout.session.completed'))).rejects.toThrow(PaymentGatewayError);
    expect(webhookEvents.insertIfNew).not.toHaveBeenCalled();
  });

  it('skips a completed session whose money is not held yet', async () => {
    const { store, useCase, retrieveAuthorization, webhookEvents } = setup();
    retrieveAuthorization.mockResolvedValueOnce({ ...HELD, intentStatus: 'processing' });

    await expect(useCase.execute(event('checkout.session.completed'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'awaiting_payment',
    });
    expect(webhookEvents.markSkipped).toHaveBeenCalledOnce();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.PENDING);
  });

  it('skips a hold that does not match the order total', async () => {
    const { store, useCase, retrieveAuthorization } = setup();
    retrieveAuthorization.mockResolvedValueOnce({ ...HELD, amountCapturableMinor: 1 });

    await expect(useCase.execute(event('checkout.session.completed'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'amount_mismatch',
    });
    expect(store.outbox).toEqual([]);
  });

  it('expires the attempt of an expired session without emitting anything', async () => {
    const { store, useCase, retrieveAuthorization, webhookEvents } = setup();

    await expect(useCase.execute(event('checkout.session.expired'))).resolves.toMatchObject({ outcome: 'processed' });

    expect(retrieveAuthorization).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).toHaveBeenCalledOnce();
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.EXPIRED);
    expect(store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.OPEN);
    expect(store.outbox).toEqual([]);
  });

  it('skips an expiry for an attempt already settled elsewhere', async () => {
    const { store, useCase } = setup();
    store.setPaymentStatus(PAYMENT_ID, PaymentStatus.VOIDED);

    await expect(useCase.execute(event('checkout.session.expired'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'already_settled',
    });
    expect(store.payment(PAYMENT_ID).status).toBe(PaymentStatus.VOIDED);
  });
});
