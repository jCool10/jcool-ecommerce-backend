import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { InboxStore } from '@shared/messaging/inbox/inbox.store';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '@shared/messaging/queue/domain-event.processor';
import { dispatcherWith } from '@shared/messaging/testing/domain-event-dispatcher.double';
import { sampleId } from '@shared/testing/id-generator.double';
import { SagaKickExecutor } from '../../application/saga/saga-kick.executor';
import type { AdvanceCheckoutSagaUseCase } from '../../application/use-cases/advance-checkout-saga.use-case';
import {
  AuthorizationBeforePlacementError,
  type OnPaymentAuthorizedUseCase,
} from '../../application/use-cases/on-payment-authorized.use-case';
import { PaymentAuthorizedHandler } from './payment-authorized.handler';

const ORDER_ID = sampleId(2);
const EVENT_ID = sampleId(3);
const TX = { tx: true } as unknown as DrizzleTx;

function job(payload: Record<string, unknown> = { orderId: ORDER_ID, amountMinor: 240_000, currency: 'VND' }) {
  return {
    outboxId: sampleId(1),
    aggregateType: 'Payment',
    aggregateId: sampleId(4),
    eventType: 'payment.authorized',
    payload: { paymentId: sampleId(4), authorizedAt: '2026-03-01T09:30:00.000Z', ...payload },
    occurredAt: '2026-03-01T09:30:00.000Z',
    traceparent: null,
  } satisfies DomainEventJob;
}

function build(execute: OnPaymentAuthorizedUseCase['execute'] = vi.fn(() => Promise.resolve(null))) {
  const mint = vi.fn(() => Promise.resolve([EVENT_ID]));
  const handler = new PaymentAuthorizedHandler({ execute } as unknown as OnPaymentAuthorizedUseCase, { mint });
  return { handler, mint, execute };
}

describe('PaymentAuthorizedHandler', () => {
  it.each([
    ['no order id', { orderId: undefined }],
    ['a fractional amount', { amountMinor: 1.5 }],
    ['an amount as text', { amountMinor: '240000' }],
    ['no currency', { currency: undefined }],
  ])('refuses %s for good, before minting anything', async (_label, broken) => {
    const { handler, mint } = build();

    await expect(
      handler.prepare(job({ orderId: ORDER_ID, amountMinor: 240_000, currency: 'VND', ...broken })),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(mint).not.toHaveBeenCalled();
  });

  it('mints the event id before the transaction and applies the authorization inside it', async () => {
    const { handler, mint, execute } = build();

    const step = await handler.prepare(job());
    expect(mint).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    await expect(step(TX)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ orderId: ORDER_ID, amountMinor: 240_000, currency: 'VND' }, TX, EVENT_ID);
  });

  it('leaves an authorization that beat its placement to be redelivered, not dead-lettered', async () => {
    const { handler } = build(vi.fn(() => Promise.reject(new AuthorizationBeforePlacementError(ORDER_ID))));

    const error = await (await handler.prepare(job()))(TX).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationBeforePlacementError);
    expect(error).not.toBeInstanceOf(PermanentError);
  });

  it('hands back what must wait for the commit as the effect', async () => {
    const afterCommit = vi.fn();
    const { handler } = build(vi.fn(() => Promise.resolve(afterCommit)));

    const effect = await (await handler.prepare(job()))(TX);
    expect(afterCommit).not.toHaveBeenCalled();
    await (effect as () => Promise<void>)();

    expect(afterCommit).toHaveBeenCalledOnce();
  });

  // The effect runs inside the BullMQ job and holds a slot of the shared queue for as long as it awaits.
  it('lets the consume finish while the saga it kicked is still waiting on a participant', async () => {
    const advance = { execute: vi.fn(() => new Promise<void>(() => undefined)) };
    const kicks = new SagaKickExecutor(
      advance as unknown as AdvanceCheckoutSagaUseCase,
      fakeConfigService({ 'saga.kickConcurrency': 1 }),
      fakePinoLogger(),
    );
    const { handler } = build(vi.fn(() => Promise.resolve(() => kicks.submit(ORDER_ID))));
    const processor = new DomainEventProcessor(
      { transaction: (run: (tx: unknown) => unknown) => Promise.resolve(run(TX)) } as unknown as DrizzleDB,
      { recordEventConsumed: vi.fn() } as unknown as MetricsPort,
      { claim: () => Promise.resolve(true) } as unknown as InboxStore,
      dispatcherWith({ prepareAuthorized: (event) => handler.prepare(event) }),
      fakePinoLogger(),
    );

    await processor.process(job());

    expect(advance.execute).toHaveBeenCalledWith(ORDER_ID);
  });
});
