import { execFileSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/database/migrate';
import { POSTGRES_IMAGE } from '../setup/databases';
import { eventually, sleep } from '../setup/eventually';
import { createTestApp } from '../setup/test-app';

const TTL_MS = 6_000;
const FENCE_MARGIN_MS = 2_000;
const RENEW_EVERY_MS = 1_000;
const FENCE_AFTER_MS = TTL_MS - FENCE_MARGIN_MS;

// Its own Postgres, since pausing the shared one would stall every other spec.
describe('the lease store going away', () => {
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(postgres.getConnectionUri());
    app = await createTestApp(postgres.getConnectionUri(), {
      ID_LEASE_TTL_MS: String(TTL_MS),
      ID_LEASE_FENCE_MARGIN_MS: String(FENCE_MARGIN_MS),
      ID_LEASE_RENEW_EVERY_MS: String(RENEW_EVERY_MS),
      ID_LEASE_QUARANTINE_MS: '0',
      DB_QUERY_TIMEOUT_MS: '300',
      DB_POOL_CONNECTION_TIMEOUT_MS: '300',
    });
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  const mintStatus = async () => (await request(app.getHttpServer()).post('/v1/ids').send({ bucket: 0 })).status;

  it('mints until its own fence, refuses after, and takes a node again once the store is back', async () => {
    expect(await mintStatus()).toBe(200);

    const pausedAt = Date.now();
    execFileSync('docker', ['pause', postgres.getId()]);
    const answers: { atMs: number; status: number }[] = [];
    try {
      while (Date.now() - pausedAt < TTL_MS + 1_000) {
        answers.push({ atMs: Date.now() - pausedAt, status: await mintStatus() });
        await sleep(50);
      }
    } finally {
      execFileSync('docker', ['unpause', postgres.getId()]);
    }

    const firstRefusal = answers.findIndex((answer) => answer.status !== 200);
    expect(firstRefusal).toBeGreaterThan(0);
    // The last renewal landed at most one interval before the pause, and the fence is measured from it.
    expect(answers[firstRefusal]?.atMs).toBeGreaterThanOrEqual(FENCE_AFTER_MS - RENEW_EVERY_MS - 100);
    expect(answers[firstRefusal]?.atMs).toBeLessThanOrEqual(FENCE_AFTER_MS + 300);
    expect(answers.slice(firstRefusal).every((answer) => answer.status === 503)).toBe(true);

    // By now the store has expired the lease, so the replica must notice the loss and claim anew.
    await eventually(async () => ((await mintStatus()) === 200 ? true : undefined), 10_000);
    const { text } = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(text).toMatch(/^id_lease_lost_total 1$/m);
    expect(text).toMatch(/^id_lease_renew_failures_total [1-9]\d*$/m);
  });
});
