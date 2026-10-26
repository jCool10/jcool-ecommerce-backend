import type { INestApplication } from '@nestjs/common';
import type { Client, WorkflowExecutionInfo } from '@temporalio/client';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../src/modules/order/application/ports/order-inventory-participant.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import { checkoutWorkflowId } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { TEMPORAL_CLIENT } from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { eventually } from '../setup/eventually';
import {
  holdCalls,
  orderEventTypes,
  relayedAuthorizations,
  releaseHung,
  sagaHandle,
} from '../setup/fixtures/checkout-saga.fixture';
import {
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  openSession,
  postWebhook,
  readOrder,
  readPayment,
  readStock,
  reservationsFor,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_duplicate_delivery';
const ON_HAND = 5;
const WEBHOOK_DELIVERIES = 5;
const JOB_DELIVERIES = 3;
const SAGA_ENV = { SAGA_RETRY_BASE_MS: '100', SAGA_RETRY_CAP_MS: '500' };

describe('Checkout saga duplicate delivery (integration, two apps on one task queue, fake Stripe)', () => {
  let first: INestApplication;
  let second: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app: first, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
    // The same fake behind both, so an activity sees the session and intent whichever app runs it.
    ({ app: second } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV, [], { gateway }));
  });
  closeAppAfterAll(() => first);
  closeAppAfterAll(() => second);
  resetSagasAndDatabaseBeforeEach(
    () => [first, second],
    () => pool,
  );
  afterEach(() => {
    releaseHung();
    vi.restoreAllMocks();
  });

  const apps = () => [first, second];
  const inventoryOf = (app: INestApplication) => app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT);
  const paymentOf = (app: INestApplication) => app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT);

  async function runsOf(orderId: string): Promise<WorkflowExecutionInfo[]> {
    const runs: WorkflowExecutionInfo[] = [];
    const query = `WorkflowId = '${checkoutWorkflowId(orderId)}'`;
    for await (const run of first.get<Client>(TEMPORAL_CLIENT).workflow.list({ query })) runs.push(run);
    return runs;
  }

  it('captures, commits and pays once under a repeated webhook and a redelivered job', async () => {
    const sku = await seedSellableSku(first, { onHand: ON_HAND });
    const token = await buyerWithCart(first, sku.variantId);
    const orderId = (await checkout(first, token).expect(201)).body.id as string;
    const sessionId = (await openSession(first, token, orderId).expect(201)).body.providerSessionId as string;
    // Held on both workers until every duplicate is in, so each one meets the open run; one landing
    // after it closed would start a late run instead, which the late-authorization cases cover.
    const captures = apps().map((app) => holdCalls(paymentOf(app), 'capture'));
    const commits = apps().map((app) => vi.spyOn(inventoryOf(app), 'commit'));

    const intentId = gateway.authorize(sessionId);
    const { amountMinor, currency } = await readPayment(first, orderId);
    const event = checkoutSessionCompleted(sessionId, { amountMinor, currency, paymentStatus: 'unpaid' });
    const webhooks = await Promise.all(
      Array.from({ length: WEBHOOK_DELIVERIES }, (_, n) =>
        postWebhook(apps()[n % 2], signWebhook({ secret: WEBHOOK_SECRET, event })),
      ),
    );
    expect(webhooks.map(({ status }) => status)).toEqual(Array(WEBHOOK_DELIVERIES).fill(200));

    const jobs = await relayedAuthorizations(first, orderId);
    expect(jobs).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: JOB_DELIVERIES }, (_, n) => apps()[n % 2].get(DomainEventProcessor).process(jobs[0].data)),
    );
    expect(results.toSorted()).toEqual(['duplicate', 'duplicate', 'processed']);

    await eventually(
      () => captures.reduce((total, held) => total + held.count, 0),
      (count) => count >= 1,
    );
    for (const held of captures) held.release();
    expect(await sagaHandle(first, orderId).result()).toBe('COMPLETED');

    expect((await readOrder(first, orderId)).status).toBe('PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(commits.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(1);
    expect(await readStock(first, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND - 1, quantityReserved: 0 });
    expect((await reservationsFor(first, orderId)).map(({ status }) => status)).toEqual(['COMMITTED']);
    expect((await orderEventTypes(first, orderId)).filter((type) => type === 'order.paid')).toHaveLength(1);
    const runs = await eventually(
      () => runsOf(orderId),
      (found) => found.length > 0 && found.every(({ status }) => status.name === 'COMPLETED'),
    );
    expect(runs).toHaveLength(1);
    expect((await auditLedgerInvariants(first, { [sku.variantId]: ON_HAND })).violations).toEqual([]);
  });
});
