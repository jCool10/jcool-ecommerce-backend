import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { InboxStore } from '@shared/messaging/inbox/inbox.store';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '@shared/messaging/queue/domain-event.processor';
import { dispatcherWith } from '@shared/messaging/testing/domain-event-dispatcher.double';
import { sampleId } from '@shared/testing/id-generator.double';
import type { OnPaymentAuthorizedUseCase } from '../../application/use-cases/on-payment-authorized.use-case';
import { PaymentAuthorizedHandler } from './payment-authorized.handler';

const ORDER_ID = sampleId(2);
const PAYMENT_ID = sampleId(4);
const AUTHORIZED_AT = '2026-03-01T09:30:00.000Z';
const TX = { tx: true } as unknown as DrizzleTx;

function job(overrides: Record<string, unknown> = {}): DomainEventJob {
  return {
    outboxId: sampleId(1),
    aggregateType: 'Payment',
    aggregateId: PAYMENT_ID,
    eventType: 'payment.authorized',
    payload: {
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: 240_000,
      currency: 'VND',
      authorizedAt: AUTHORIZED_AT,
      ...overrides,
    },
    occurredAt: AUTHORIZED_AT,
    traceparent: null,
  };
}

function build(execute = vi.fn<OnPaymentAuthorizedUseCase['execute']>(() => Promise.resolve())) {
  const handler = new PaymentAuthorizedHandler({ execute } as unknown as OnPaymentAuthorizedUseCase);
  return { handler, execute };
}

function processorFor(handler: PaymentAuthorizedHandler, claim = vi.fn(() => Promise.resolve(true))) {
  const transaction = vi.fn((run: (tx: unknown) => unknown) => Promise.resolve(run(TX)));
  const processor = new DomainEventProcessor(
    { transaction } as unknown as DrizzleDB,
    { recordEventConsumed: vi.fn() } as unknown as MetricsPort,
    { claim } as unknown as InboxStore,
    dispatcherWith({ applyAuthorized: (event) => handler.apply(event) }),
    fakePinoLogger(),
  );
  return { processor, transaction, claim };
}

describe('PaymentAuthorizedHandler', () => {
  it.each([
    ['no payment id', { paymentId: undefined }],
    ['no order id', { orderId: undefined }],
    ['a fractional amount', { amountMinor: 1.5 }],
    ['an amount as text', { amountMinor: '240000' }],
    ['no currency', { currency: undefined }],
    ['an unparseable authorization time', { authorizedAt: 'yesterday' }],
  ])('refuses %s for good, without reaching the saga', async (_label, broken) => {
    const { handler, execute } = build();

    await expect(handler.apply(job(broken))).rejects.toBeInstanceOf(PermanentError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands the authorization to the use case with its time as a Date', async () => {
    const { handler, execute } = build();

    await handler.apply(job());

    expect(execute).toHaveBeenCalledExactlyOnceWith({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: 240_000,
      currency: 'VND',
      authorizedAt: new Date(AUTHORIZED_AT),
    });
  });

  it('signals before the inbox claim, leaving nothing to do inside the transaction', async () => {
    const { handler, execute } = build();
    const { processor, claim } = processorFor(handler);

    await processor.process(job());

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
  });

  it('fails the claiming transaction when the saga cannot be reached, so the message is redelivered', async () => {
    const outage = new Error('temporal unavailable');
    const { handler } = build(vi.fn(() => Promise.reject(outage)));
    const { processor, transaction } = processorFor(handler);

    await expect(processor.process(job())).rejects.toBe(outage);

    await expect(transaction.mock.results[0]?.value).rejects.toBe(outage);
  });
});
