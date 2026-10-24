import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_webhook_contract_0123456789';

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

// A genuine signature over arbitrary bytes: shapes only an authentic sender can produce.
function signRaw(rawBody: string): { rawBody: string; headers: Record<string, string> } {
  const ts = Math.floor(Date.now() / 1000);
  return {
    rawBody,
    headers: {
      [STRIPE_SIGNATURE_HEADER]: signStripeStyle(WEBHOOK_SECRET, ts, rawBody),
      'content-type': 'application/json',
    },
  };
}

describe('Payment webhook contract at the edges (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const webhookRows = () => db.select().from(schema.webhookEvents);

  const post = (signed: { rawBody: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);

  // Known defect. Intended: an authentically signed delivery gets a deliberate answer and leaves a
  // record. Actual: verifyAndParseStripeEvent runs JSON.parse and the id/type check unguarded, before
  // ProcessWebhookEventUseCase opens its transaction, so the answer is an unmapped 500 that Stripe
  // retries, and no webhook_events row is written.
  it('500s an authentic delivery whose body shape it cannot read, and records nothing', async () => {
    await post(signRaw(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }))).expect(500);
    await post(signRaw(JSON.stringify({ id: 42, type: 'checkout.session.completed' }))).expect(500);
    await post(signRaw(JSON.stringify([{ type: 'checkout.session.completed' }]))).expect(500);

    expect(await webhookRows()).toHaveLength(0);
  });

  // Known defect. Intended: a signed delivery is recorded before it is judged. Actual: Express's
  // strict JSON parser refuses non-JSON and bare scalars before the signature is checked, and
  // nothing is written.
  it('refuses an unparseable body with 400 before verifying, recording nothing', async () => {
    await post(signRaw('<html>502 Bad Gateway</html>')).expect(400);
    await post(signRaw(JSON.stringify('checkout.session.completed'))).expect(400);

    expect(await webhookRows()).toHaveLength(0);
  });
});
