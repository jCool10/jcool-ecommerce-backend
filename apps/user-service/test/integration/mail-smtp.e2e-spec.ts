import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAppWithPool } from '../setup/harness';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const MAIL_FROM = 'no-reply@jcool.test';
const PUBLIC_URL = 'https://app.jcool.test';
const PASSWORD = 'Password123!';
// Above the shipped 10s: a cold first connection through a fresh container can outlast it, and
// the claim here is that the token redeems, not that 10s is enough.
const MAIL_TIMEOUT_MS = '20000';

let seq = 0;
const freshEmail = () => `mail-${Date.now()}-${seq++}@test.local`;

function linkIn(body: string, path: string): URL {
  const match = body.match(new RegExp(`${PUBLIC_URL}${path}\\?token=\\S+`));
  if (!match) throw new Error(`No ${path} link in the message body`);
  return new URL(match[0]);
}

// Auth mail carries a raw redeemable token, so the proof it owes is that the token that arrives redeems.
describe('Auth mail over SMTP (integration, real Mailpit + Postgres + Redis)', () => {
  let mail: StartedMailServer;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    mail = await startMailServer();
    ({ app, pool } = await createTestAppWithPool({
      SMTP_URL: mail.smtpUrl,
      MAIL_FROM,
      APP_PUBLIC_URL: PUBLIC_URL,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      MAIL_TIMEOUT_MS,
    }));
  }, 180_000);

  // The app goes first: it still holds an SMTP connection to the server.
  afterAll(async () => {
    await app?.close();
    await mail?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await mail.clear();
  });

  it('delivers a verification mail whose token redeems', async () => {
    const email = freshEmail();

    await request(app.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(201);

    const [delivered] = await mail.waitForMail(email);
    expect(delivered.Subject).toBe('Verify your email address');

    const token = linkIn(await mail.body(delivered.ID), '/auth/verify-email').searchParams.get('token');
    await request(app.getHttpServer()).post('/auth/verify-email').send({ token }).expect(204);
  });

  it('sends one mail per registration, not one per attempt at the address', async () => {
    const email = freshEmail();

    await request(app.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await mail.waitForMail(email);
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(409);

    expect(await mail.messages()).toHaveLength(1);
  });

  it('delivers a reset mail whose token redeems', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await mail.waitForMail(email);
    await mail.clear();

    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(202);

    const [delivered] = await mail.waitForMail(email);
    const token = linkIn(await mail.body(delivered.ID), '/auth/reset-password').searchParams.get('token');
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, password: 'NewPassword123!' })
      .expect(204);
  });

  it('answers forgot-password identically for an address nobody owns', async () => {
    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: freshEmail() }).expect(202);

    expect(await mail.messages()).toHaveLength(0);
  });

  // A throwing mailer would turn the existing-account branch into a 500: an enumeration oracle.
  it('keeps registering with uniform answers while the mail server is down', async () => {
    // SMTP_URL is read once at compile, so an unreachable server means an app built that way.
    const broken = await createTestApp({
      SMTP_URL: UNREACHABLE_SMTP_URL,
      MAIL_FROM,
      APP_PUBLIC_URL: PUBLIC_URL,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    });
    try {
      const email = freshEmail();
      await request(broken.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
      await request(broken.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(202);
      await request(broken.getHttpServer()).post('/auth/forgot-password').send({ email: freshEmail() }).expect(202);

      // The failure is visible only as a metric.
      await vi.waitFor(
        async () => {
          const { text } = await request(broken.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
          expect(text).toMatch(/mail_send_failures_total\{kind="email_verification"\} [1-9]/);
          expect(text).toMatch(/mail_send_failures_total\{kind="password_reset"\} [1-9]/);
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await broken.close();
    }
  });
});
