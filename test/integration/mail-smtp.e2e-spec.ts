import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { startMailServer, UNREACHABLE_SMTP_URL, type StartedMailServer } from '../setup/mail-server';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-mail-metrics-token';
const MAIL_FROM = 'no-reply@jcool.test';
const PUBLIC_URL = 'https://app.jcool.test';
const PASSWORD = 'Password123!';
// Above the shipped 10s, below the 25s ceiling. What is under test is that the token which arrives
// redeems, not that 10s is enough: on a cold runner the first connection through a freshly started
// container can outlast the production timeout, and abandoning that send would fail the wrong claim.
const MAIL_TIMEOUT_MS = '20000';

let seq = 0;
const freshEmail = () => `mail-${Date.now()}-${seq++}@test.local`;

function linkIn(body: string, path: string): URL {
  const match = body.match(new RegExp(`${PUBLIC_URL}${path}\\?token=\\S+`));
  if (!match) throw new Error(`No ${path} link in the message body`);
  return new URL(match[0]);
}

/**
 * Auth mail over a real SMTP server, delivered to a real inbox and read back out of it.
 *
 * Auth mail is the one path that carries a raw, redeemable token, which is why it is sent directly
 * rather than through the outbox — so the proof it has to offer is that the token which arrives in
 * the message actually redeems.
 */
describe('Auth mail over SMTP (integration, real Mailpit + Postgres + Redis)', () => {
  let mail: StartedMailServer;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    mail = await startMailServer();
    app = await createTestApp({
      SMTP_URL: mail.smtpUrl,
      MAIL_FROM,
      APP_PUBLIC_URL: PUBLIC_URL,
      METRICS_TOKEN,
      MAIL_TIMEOUT_MS,
    });
    pool = app.get<Pool>(PG_POOL);
  }, 180_000);

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

    // Polled, not asserted: the use case dispatches the mail without awaiting it, so a 201 means the
    // signup is persisted and nothing about the message. Asserting here would pass or fail by
    // machine speed.
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

  // The enumeration oracle a throwing mailer would open: these routes answer the same either way,
  // so a dead mail server must not turn the existing-account branch into a 500.
  it('keeps registering, and keeps its answers uniform, when the mail server is unreachable', async () => {
    const broken = await createTestApp({
      SMTP_URL: UNREACHABLE_SMTP_URL,
      MAIL_FROM,
      APP_PUBLIC_URL: PUBLIC_URL,
      METRICS_TOKEN,
    });
    try {
      const email = freshEmail();
      await request(broken.getHttpServer()).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
      await request(broken.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(202);
      await request(broken.getHttpServer()).post('/auth/forgot-password').send({ email: freshEmail() }).expect(202);

      // The failure is only visible as a metric — which is the whole point of counting it.
      await vi.waitFor(
        async () => {
          const { text } = await request(broken.getHttpServer())
            .get('/metrics')
            .set('Authorization', `Bearer ${METRICS_TOKEN}`)
            .expect(200);
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
