import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { DRIZZLE, type DrizzleDB } from '../../../src/database';
import * as schema from '../../../src/database/schema';
import { PAYMENT_GATEWAY } from '../../../src/modules/payment/application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from '../../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { checkoutSessionCompleted, signWebhook, type SignedWebhook } from '../sign-webhook.helper';

export function postWebhook(app: INestApplication, signed: SignedWebhook): request.Test {
  return request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);
}

/** Newest first, so a retried session wins over its dead predecessor. */
export async function readPayment(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.orderId, orderId))
    .orderBy(desc(schema.payments.createdAt))
    .limit(1);
  return row;
}

/** The order's `payment_orders` header, undefined when the participant never saw the order. */
export async function readPaymentOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.paymentOrders).where(eq(schema.paymentOrders.orderId, orderId));
  return row;
}

/**
 * The buyer completes the manual-capture session: the fake gateway now holds the charge and the
 * provider reports it with a signed `checkout.session.completed`. Returns the intent id.
 */
export async function authorizeSession(
  app: INestApplication,
  sessionId: string,
  orderId: string,
  eventId = `evt_auth_${orderId}`,
): Promise<string> {
  const gateway = app.get(PAYMENT_GATEWAY);
  if (!(gateway instanceof FakeSignerGatewayAdapter)) throw new Error('authorizeSession needs the fake gateway');
  const intentId = gateway.authorize(sessionId);
  const { amountMinor, currency } = await readPayment(app, orderId);
  const secret = app.get(ConfigService).getOrThrow<string>('payment.webhookSecret');
  const event = checkoutSessionCompleted(sessionId, { amountMinor, currency, paymentStatus: 'unpaid' }, { eventId });
  await postWebhook(app, signWebhook({ secret, event })).expect(200);
  return intentId;
}
