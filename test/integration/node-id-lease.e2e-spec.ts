import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { UuidV8Generator } from '@shared/identity';
import { LEASE_HOLDER } from '@shared/identity/identity.module';
import { DrizzleNodeIdLeaseRepository } from '@shared/identity/lease/drizzle-node-id-lease.repository';
import type { LeaseHolder } from '@shared/identity/lease/lease-holder';
import { nodeLeases } from '@shared/identity/lease/node-lease.schema';
import { parseServicePools } from '@shared/identity/lease/service-pools';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { resetDatabase, resetLeases } from '../setup/reset-database';
import { createUserApp } from '../setup/test-app.factory';

// Matches test/vitest-e2e.config.mts.
const TTL_SECONDS = 6;
const SKEW_MS = 1_000;
// Long enough that a slow CI box cannot reach the give-up exit between the fence and app.close().
const STEAL_TTL_SECONDS = 15;
const STEAL_DETECTION_MS = (STEAL_TTL_SECONDS / 3) * 1_000 + 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every property here is one the id scheme rests on rather than one a user can see: uniqueness of a
 * UUIDv8 is the node id being this process's alone, and nothing in the mint path notices when it is
 * not. The unit suites prove the branches; this proves real apps and real statements reach them.
 */
describe('Node-id lease (integration)', () => {
  let leasePool: Pool;
  let db: DrizzleDB;
  const started: INestApplication[] = [];

  function repository(pools: string, ttlSeconds = TTL_SECONDS): DrizzleNodeIdLeaseRepository {
    return new DrizzleNodeIdLeaseRepository(db, parseServicePools(pools), ttlSeconds, SKEW_MS);
  }

  async function boot(envOverrides: Record<string, string> = {}): Promise<INestApplication> {
    const app = await createUserApp(envOverrides);
    started.push(app);
    return app;
  }

  function nodeOf(app: INestApplication): number | null {
    return app.get<LeaseHolder>(LEASE_HOLDER).node;
  }

  beforeAll(() => {
    leasePool = new Pool({ connectionString: inject('IDENTITY_LEASE_DATABASE_URL') });
    db = drizzle(leasePool, { schema: { nodeLeases } });
  });

  afterAll(async () => {
    await leasePool.end();
  });

  beforeEach(async () => {
    await resetLeases(leasePool);
  });

  afterEach(async () => {
    for (const app of started.splice(0).reverse()) {
      await app.close().catch(() => undefined);
    }
  });

  it('hands two replicas in one process different node ids', async () => {
    const [first, second] = [await boot(), await boot()];

    expect(nodeOf(first)).not.toBeNull();
    expect(nodeOf(first)).not.toBe(nodeOf(second));
    expect(first.get(UuidV8Generator).nodeId).toBe(nodeOf(first));
    expect(second.get(UuidV8Generator).nodeId).toBe(nodeOf(second));
  });

  // Pools are per service, so the same number in two of them addresses two id spaces. This is what
  // lets the seed scripts mint alongside a running fleet instead of reserving a node from it.
  it('lets two services hold node 0 at once', async () => {
    const leases = repository('user:2,scripts:2');

    const user = await leases.acquire('user', 'holder-user');
    const scripts = await leases.acquire('scripts', 'holder-scripts');

    expect(user).toMatchObject({ service: 'user', node: 0 });
    expect(scripts).toMatchObject({ service: 'scripts', node: 0 });
    expect(user?.leaseId).not.toBe(scripts?.leaseId);

    // And neither renewal disturbs the other's row.
    await expect(leases.renew(user!, 0)).resolves.toBe(true);
    await expect(leases.renew(scripts!, 0)).resolves.toBe(true);
  });

  // Acquire seeds a pool on first contact, so a typo would mint one of its own and the two halves of
  // a fleet would never see each other. Refused at boot instead.
  it('refuses to boot under an undeclared service name', async () => {
    await expect(boot({ IDENTITY_LEASE_SERVICE: 'usr' })).rejects.toThrow(/Unknown id-service pool "usr"/);
  });

  // No degraded mode: a process with no node id has no id it may safely mint under.
  it('refuses to boot when the pool is exhausted', async () => {
    const holder = await boot({ ID_SERVICE_POOLS: 'user:1' });
    expect(nodeOf(holder)).toBe(0);

    await expect(boot({ ID_SERVICE_POOLS: 'user:1' })).rejects.toThrow(/No node id available in the "user" pool/);
  });

  describe('when the node is stolen out from under a running app', () => {
    async function steal(node: number): Promise<void> {
      await leasePool.query(
        `UPDATE node_leases SET lease_id = gen_random_uuid(), holder = 'thief', renewed_at = now()
         WHERE service = 'user' AND node = $1`,
        [node],
      );
    }

    async function waitForFence(app: INestApplication): Promise<void> {
      const deadline = Date.now() + STEAL_DETECTION_MS;
      while (Date.now() < deadline) {
        if (app.get(UuidV8Generator).isFenced) return;
        await sleep(100);
      }
      throw new Error('The holder never noticed its lease was taken');
    }

    it('fences minting, answers 503 and goes unready', async () => {
      const app = await boot({ IDENTITY_LEASE_TTL_SECONDS: String(STEAL_TTL_SECONDS) });
      await request(app.getHttpServer()).get('/health/ready').expect(200);

      await steal(nodeOf(app)!);
      await waitForFence(app);

      // 503, not 500: the process cannot serve this, but another one can.
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'fenced@test.local', password: 'Password123!' })
        .expect(503);
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      // Nothing was minted under the stolen node — the refusal happens before the id exists.
      expect(app.get(UuidV8Generator).isFenced).toBe(true);
    });

    // Shutting down must not hand the node back: the row is the thief's now, and a release keyed on
    // the old lease_id matches nothing — but a release that ignored the token would free their lease.
    it('leaves the thief holding the row on shutdown', async () => {
      const app = await boot({ IDENTITY_LEASE_TTL_SECONDS: String(STEAL_TTL_SECONDS) });
      const node = nodeOf(app)!;
      await steal(node);
      await waitForFence(app);

      await app.close();
      started.splice(started.indexOf(app), 1);

      const { rows } = await leasePool.query<{ holder: string | null }>(
        `SELECT holder FROM node_leases WHERE service = 'user' AND node = $1`,
        [node],
      );
      expect(rows[0]?.holder).toBe('thief');
    });
  });

  describe('reclaiming a released node', () => {
    // "Released nodes are immediately re-acquirable" is loose: the guard still has to clear, because
    // the next holder's clock may lag the last one's and would otherwise replay its milliseconds.
    it('holds the node back until the skew window past the last mint has passed', async () => {
      const leases = repository('solo:1');
      const lease = (await leases.acquire('solo', 'holder-1'))!;
      const lastMs = Date.now();

      await leases.release(lease, lastMs);

      await expect(leases.acquire('solo', 'holder-2')).resolves.toBeNull();

      await sleep(SKEW_MS + 500);
      const reclaimed = await leases.acquire('solo', 'holder-2');
      expect(reclaimed).toMatchObject({ service: 'solo', node: 0 });
      expect(reclaimed?.leaseId).not.toBe(lease.leaseId);
    });

    // The high-water mark travels with the release rather than being left at the last renewal's
    // value, which would be up to a renewal interval stale.
    it('keeps the released high-water mark for the next holder to respect', async () => {
      const leases = repository('solo:1');
      const lease = (await leases.acquire('solo', 'holder-1'))!;
      const lastMs = Date.now();

      await leases.release(lease, lastMs);

      const { rows } = await leasePool.query<{ last_ts_ms: string; lease_id: string | null }>(
        `SELECT last_ts_ms, lease_id FROM node_leases WHERE service = 'solo' AND node = 0`,
      );
      expect(Number(rows[0].last_ts_ms)).toBe(lastMs);
      expect(rows[0].lease_id).toBeNull();
    });

    // A renewal only ever raises it, so an out-of-order report cannot walk it backwards.
    it('never lowers the high-water mark', async () => {
      const leases = repository('solo:1');
      const lease = (await leases.acquire('solo', 'holder-1'))!;

      await leases.renew(lease, 5_000);
      await leases.renew(lease, 1_000);

      const { rows } = await leasePool.query<{ last_ts_ms: string }>(
        `SELECT last_ts_ms FROM node_leases WHERE service = 'solo' AND node = 0`,
      );
      expect(Number(rows[0].last_ts_ms)).toBe(5_000);
    });

    it('reports a renewal against a stolen lease as lost', async () => {
      const leases = repository('solo:1');
      const lease = (await leases.acquire('solo', 'holder-1'))!;

      await leasePool.query(`UPDATE node_leases SET lease_id = gen_random_uuid() WHERE service = 'solo' AND node = 0`);

      await expect(leases.renew(lease, 0)).resolves.toBe(false);
    });
  });

  // A graceful shutdown is the one path that returns a node, and it has to survive the skew guard the
  // same way any other reclaim does.
  it('returns the node on shutdown', async () => {
    const first = await boot({ ID_SERVICE_POOLS: 'user:1' });
    expect(nodeOf(first)).toBe(0);
    await first.close();
    started.splice(started.indexOf(first), 1);

    await sleep(SKEW_MS + 500);

    const second = await boot({ ID_SERVICE_POOLS: 'user:1' });
    expect(nodeOf(second)).toBe(0);
  });

  // The lease rows are process-lifetime state shared across a whole run; the per-suite truncate that
  // clears an app's tables must not reach them, or a live holder's row would vanish mid-run.
  it('survives the per-suite database reset', async () => {
    const app = await boot();
    const node = nodeOf(app)!;
    const userPool = new Pool({ connectionString: inject('USER_DATABASE_URL') });

    try {
      await resetDatabase(userPool);
    } finally {
      await userPool.end();
    }

    const { rows } = await leasePool.query(`SELECT 1 FROM node_leases WHERE service = 'user' AND node = $1`, [node]);
    expect(rows).toHaveLength(1);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});
