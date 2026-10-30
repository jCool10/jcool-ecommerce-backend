import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';
import { postWebhook } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import type { SignedWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_webhook_raw_body_00001';

// Spacing and key order a JSON parse and re-stringify would not keep.
const bodyOf = (eventId: string) =>
  `{ "type":"charge.refunded",  "id":"${eventId}",\n  "data":{"object":{"id":"ch_1","amount":150000}} }`;

const signRaw = (rawBody: string): SignedWebhook => ({
  rawBody,
  headers: {
    'stripe-signature': signStripeStyle(WEBHOOK_SECRET, Math.floor(Date.now() / 1000), rawBody),
    'content-type': 'application/json',
  },
});

describe('Webhook raw body (integration, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const loggedEventIds = async () =>
    (await db.select({ id: schema.webhookEvents.providerEventId }).from(schema.webhookEvents)).map((row) => row.id);

  it('verifies the signature over the exact bytes Stripe sent', async () => {
    await postWebhook(app, signRaw(bodyOf('evt_raw_exact'))).expect(200, { status: 'ignored' });

    expect(await loggedEventIds()).toEqual(['evt_raw_exact']);
  });

  it('refuses a body one byte off what was signed with 401 and logs nothing', async () => {
    const signed = signRaw(bodyOf('evt_raw_tampered'));

    await postWebhook(app, { ...signed, rawBody: signed.rawBody.replace('150000', '150001') }).expect(401);

    expect(await loggedEventIds()).toEqual([]);
  });
});
