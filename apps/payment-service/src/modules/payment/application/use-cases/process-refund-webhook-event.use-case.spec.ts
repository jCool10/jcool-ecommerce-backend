import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentRefundStatus } from '../../domain/payment-refund-status';
import { PaymentStatus } from '../../domain/payment-status';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import { fakeRefundGateway } from '../../testing/fake-refund-gateway';
import { CHARGE, InMemoryParticipantStore } from '../../testing/in-memory-participant-store';
import { PaymentGatewayError, type VerifiedEvent } from '../ports/payment-gateway.port';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { ProcessRefundWebhookEventUseCase } from './process-refund-webhook-event.use-case';

const ORDER_ID = '7001';
const PAYMENT_ID = '8001';

function event(refundId: string, type = 'refund.updated', providerEventId = `evt_${refundId}_${type}`) {
  return {
    kind: 'valid',
    providerEventId,
    type,
    payload: { data: { object: { id: refundId, status: 'succeeded' } } },
  } satisfies Extract<VerifiedEvent, { kind: 'valid' }>;
}

function fakeWebhookEvents() {
  const seen = new Set<string>();
  return {
    insertIfNew: vi.fn<WebhookEventRepositoryPort['insertIfNew']>((input) => {
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
    }),
    markProcessed: vi.fn<WebhookEventRepositoryPort['markProcessed']>().mockResolvedValue(undefined),
    markSkipped: vi.fn<WebhookEventRepositoryPort['markSkipped']>().mockResolvedValue(undefined),
    deleteReceivedBefore: vi.fn<WebhookEventRepositoryPort['deleteReceivedBefore']>(),
  };
}

function setup(header: PaymentOrderStatus = PaymentOrderStatus.REFUNDING) {
  const store = new InMemoryParticipantStore();
  const stripe = fakeRefundGateway();
  const intentId = stripe.capture(CHARGE);
  store.seedHeader(ORDER_ID, header);
  store.seedPayment({ id: PAYMENT_ID, orderId: ORDER_ID, status: PaymentStatus.SUCCEEDED, intentId });
  const webhookEvents = fakeWebhookEvents();
  const metrics = fakeMetricsPort();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const useCase = new ProcessRefundWebhookEventUseCase(
    store.txRunner,
    store.headerRepo,
    store.paymentRepo,
    store.refundRepo,
    webhookEvents,
    stripe.port,
    store.idGenerator,
    metrics,
    fakePinoLogger(log),
  );
  return { store, stripe, intentId, webhookEvents, metrics, log, useCase };
}

async function shopRefund(context: ReturnType<typeof setup>, recordId = true) {
  context.stripe.refunds.fail(context.intentId, 'refund_pending');
  const refund = await context.stripe.port.refundIntent(
    { intentId: context.intentId, ...CHARGE, orderId: ORDER_ID, requestedBy: '9001' },
    'refund:8001:0',
  );
  const refundId = refund.refundId as string;
  context.store.seedRefund({ orderId: ORDER_ID, paymentId: PAYMENT_ID, providerRefundId: recordId ? refundId : null });
  return refundId;
}

describe('ProcessRefundWebhookEventUseCase', () => {
  it('ignores every event that is not about a refund', async () => {
    const { useCase } = setup();

    await expect(useCase.execute({ ...event('re_1'), type: 'charge.refunded' })).resolves.toBeNull();
    await expect(useCase.execute({ ...event('re_1'), type: 'checkout.session.completed' })).resolves.toBeNull();
  });

  it('settles a REFUNDING header from the refund Stripe reads back, not from the body', async () => {
    const context = setup();
    const refundId = await shopRefund(context);
    context.stripe.refunds.settle(refundId, 'succeeded');

    await expect(context.useCase.execute(event(refundId))).resolves.toMatchObject({
      path: 'refund',
      outcome: 'processed',
      orderId: ORDER_ID,
      refundId,
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDED);
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.SUCCEEDED);
    expect(context.webhookEvents.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('binds a refund the command has not recorded yet to the order by its intent and amount', async () => {
    const context = setup();
    const refundId = await shopRefund(context, false);
    context.stripe.refunds.settle(refundId, 'succeeded');

    await expect(context.useCase.execute(event(refundId, 'refund.created'))).resolves.toMatchObject({
      outcome: 'processed',
    });
    expect(context.store.refund(ORDER_ID)).toMatchObject({ providerRefundId: refundId, status: 'SUCCEEDED' });
  });

  it('applies a redelivered event once', async () => {
    const context = setup();
    const refundId = await shopRefund(context);
    context.stripe.refunds.settle(refundId, 'failed');

    await context.useCase.execute(event(refundId, 'refund.failed'));
    await expect(context.useCase.execute(event(refundId, 'refund.failed'))).resolves.toMatchObject({
      outcome: 'duplicate',
    });
    expect(context.metrics.recordRefundOwed).toHaveBeenCalledTimes(1);
  });

  it('changes nothing for a pending report arriving after the refund succeeded', async () => {
    const context = setup(PaymentOrderStatus.REFUNDED);
    const refundId = await shopRefund(context);
    context.store.refunds.set(ORDER_ID, { ...context.store.refund(ORDER_ID)!, status: PaymentRefundStatus.SUCCEEDED });

    await expect(context.useCase.execute(event(refundId))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'already_settled',
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDED);
    expect(context.store.refund(ORDER_ID)?.status).toBe(PaymentRefundStatus.SUCCEEDED);
  });

  it('moves a refund that fails after succeeding to REFUND_FAILED and owes the money once', async () => {
    const context = setup(PaymentOrderStatus.REFUNDED);
    const refundId = await shopRefund(context);
    context.store.refunds.set(ORDER_ID, { ...context.store.refund(ORDER_ID)!, status: PaymentRefundStatus.SUCCEEDED });
    context.stripe.refunds.settle(refundId, 'failed');

    await expect(context.useCase.execute(event(refundId, 'refund.failed'))).resolves.toMatchObject({
      outcome: 'processed',
    });
    await context.useCase.execute(event(refundId, 'refund.updated'));

    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUND_FAILED);
    expect(context.store.refund(ORDER_ID)).toMatchObject({
      status: 'FAILED',
      failureReason: 'expired_or_canceled_card',
    });
    expect(context.metrics.recordRefundOwed).toHaveBeenCalledTimes(1);
    expect(context.metrics.recordRefundOwed).toHaveBeenCalledWith('refund_failed');
  });

  it('counts a refund made outside the shop on a captured order, binding it by intent, header untouched', async () => {
    const context = setup(PaymentOrderStatus.CAPTURED);
    const refundId = context.stripe.refunds.outOfBand(context.intentId);

    await expect(context.useCase.execute(event(refundId, 'refund.created'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'untracked',
      orderId: ORDER_ID,
    });
    expect(context.metrics.recordRefundUntracked).toHaveBeenCalledTimes(1);
    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, refundId, amountMinor: CHARGE.amountMinor }),
      'refund issued outside the shop',
    );
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.CAPTURED);
    expect(context.store.refund(ORDER_ID)).toBeUndefined();
  });

  it('writes nothing for a refund whose metadata names another order', async () => {
    const context = setup();
    const refundId = await shopRefund(context, false);
    const reported = await context.stripe.port.retrieveRefund(refundId);
    context.stripe.retrieveRefund.mockResolvedValue({ ...reported, status: 'succeeded', metadataOrderId: '7999' });

    await expect(context.useCase.execute(event(refundId))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'metadata_mismatch',
    });
    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, metadataOrderId: '7999' }),
      'refund metadata names another order',
    );
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)?.providerRefundId).toBeNull();
  });

  it('writes nothing for a refund in another currency than the charge', async () => {
    const context = setup();
    const refundId = await shopRefund(context);
    const reported = await context.stripe.port.retrieveRefund(refundId);
    context.stripe.retrieveRefund.mockResolvedValue({ ...reported, status: 'succeeded', currency: 'usd' });

    await expect(context.useCase.execute(event(refundId))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'currency_mismatch',
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
  });

  it('never binds a partial refund made elsewhere to the refund the shop is waiting on', async () => {
    const context = setup();
    context.store.seedRefund({ orderId: ORDER_ID, paymentId: PAYMENT_ID });
    const refundId = context.stripe.refunds.outOfBand(context.intentId, 50_000);

    await expect(context.useCase.execute(event(refundId, 'refund.created'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'unbound',
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)).toMatchObject({ providerRefundId: null, status: 'PENDING' });
    expect(context.metrics.recordRefundUntracked).not.toHaveBeenCalled();
  });

  it('never takes a failed full refund made elsewhere for the refund the shop is waiting on', async () => {
    const context = setup();
    context.store.seedRefund({ orderId: ORDER_ID, paymentId: PAYMENT_ID });
    const refundId = context.stripe.refunds.outOfBand(context.intentId);
    context.stripe.refunds.settle(refundId, 'failed');

    await expect(context.useCase.execute(event(refundId, 'refund.failed'))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'unbound',
    });
    expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
    expect(context.store.refund(ORDER_ID)).toMatchObject({ providerRefundId: null, status: 'PENDING' });
    expect(context.metrics.recordRefundOwed).not.toHaveBeenCalled();
  });

  describe('a refund adopted from several made elsewhere', () => {
    function adopted(header: PaymentOrderStatus) {
      const context = setup(header);
      const covering = [
        context.stripe.refunds.outOfBand(context.intentId, 100_000),
        context.stripe.refunds.outOfBand(context.intentId, 50_000),
      ];
      context.store.seedRefund({
        orderId: ORDER_ID,
        paymentId: PAYMENT_ID,
        coveredRefundIds: covering,
        status: header === PaymentOrderStatus.REFUNDED ? PaymentRefundStatus.SUCCEEDED : PaymentRefundStatus.PENDING,
      });
      return { context, covering };
    }

    it.each([PaymentOrderStatus.REFUNDED, PaymentOrderStatus.REFUNDING])(
      'fails under %s when any one of them fails, owing the money once',
      async (header) => {
        const { context, covering } = adopted(header);
        context.stripe.refunds.settle(covering[0], 'failed');

        await expect(context.useCase.execute(event(covering[0], 'refund.failed'))).resolves.toMatchObject({
          outcome: 'processed',
          orderId: ORDER_ID,
        });
        expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUND_FAILED);
        expect(context.store.refund(ORDER_ID)).toMatchObject({
          providerRefundId: null,
          coveredRefundIds: covering,
          status: 'FAILED',
          failureReason: 'expired_or_canceled_card',
        });
        expect(context.metrics.recordRefundOwed).toHaveBeenCalledExactlyOnceWith('refund_failed');
      },
    );

    it('settles nothing on the success of one while the refund is still pending', async () => {
      const { context, covering } = adopted(PaymentOrderStatus.REFUNDING);

      await expect(context.useCase.execute(event(covering[1]))).resolves.toMatchObject({
        outcome: 'skipped',
        reason: 'still_pending',
      });
      expect(context.store.header(ORDER_ID)?.status).toBe(PaymentOrderStatus.REFUNDING);
      expect(context.metrics.recordRefundUntracked).not.toHaveBeenCalled();
    });
  });

  it('skips a refund of a charge no attempt here made', async () => {
    const context = setup();
    const refundId = context.stripe.refunds.outOfBand(context.stripe.capture(CHARGE));

    await expect(context.useCase.execute(event(refundId))).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'unknown_intent',
      orderId: null,
    });
    expect(context.webhookEvents.markSkipped).toHaveBeenCalledTimes(1);
  });

  it('logs an event that names no refund as skipped', async () => {
    const context = setup();

    await expect(
      context.useCase.execute({ ...event('re_1'), payload: { data: { object: {} } } }),
    ).resolves.toMatchObject({ outcome: 'skipped', reason: 'no_refund_id', refundId: null });
  });

  it('throws before logging anything when Stripe cannot be asked, so Stripe redelivers', async () => {
    const context = setup();
    const refundId = await shopRefund(context);
    context.stripe.refunds.failCalls(context.intentId);

    await expect(context.useCase.execute(event(refundId))).rejects.toBeInstanceOf(PaymentGatewayError);
    expect(context.webhookEvents.insertIfNew).not.toHaveBeenCalled();
  });
});
