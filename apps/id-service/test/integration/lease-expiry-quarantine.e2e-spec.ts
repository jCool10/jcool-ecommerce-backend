import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { freshDatabase, holdAllNodesExcept, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';
import { createTestApp } from '../setup/test-app';

const NODE = 21;
const QUARANTINE_MS = 10_000;
const CLAIM = { holder: 'claimant', ttlMs: 60_000, quarantineMs: QUARANTINE_MS };

describe('lease expiry', () => {
  let leases: LeaseDatabase | undefined;
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    await leases?.close();
    app = leases = undefined;
  });

  async function expireNode(msAgo: number): Promise<void> {
    await leases?.pool.query(
      `UPDATE node_leases SET lease_until = now() - $2::int * interval '1 millisecond' WHERE node_id = $1`,
      [NODE, msAgo],
    );
  }

  it('hands an expired node out again only once the quarantine has passed', async () => {
    leases = await openLeaseDatabase();
    await holdAllNodesExcept(leases.pool, NODE);

    await expireNode(QUARANTINE_MS / 2);
    expect(await leases.store.acquire(CLAIM)).toBeNull();

    await expireNode(QUARANTINE_MS + 1_000);
    expect(await leases.store.acquire(CLAIM)).toMatchObject({ nodeId: NODE });
  });

  it('records the floor on a renewal that finds the lease expired, not extending it', async () => {
    leases = await openLeaseDatabase();
    await holdAllNodesExcept(leases.pool, NODE);
    const grant = await leases.store.acquire({ ...CLAIM, quarantineMs: 0 });
    if (grant === null) throw new Error('no node');
    await expireNode(1);

    const lastMs = Date.now();
    expect(await leases.store.renew({ ...grant, holder: CLAIM.holder, ttlMs: CLAIM.ttlMs, lastMs })).toBeNull();

    const { rows } = await leases.pool.query<{ max_ts_ms: string; live: boolean }>(
      'SELECT max_ts_ms, lease_until > now() AS live FROM node_leases WHERE node_id = $1',
      [NODE],
    );
    expect(rows[0]).toEqual({ max_ts_ms: String(lastMs), live: false });
  });

  it('tells the next holder where the previous lease ended, and where its own ends', async () => {
    leases = await openLeaseDatabase();
    await holdAllNodesExcept(leases.pool, NODE);
    const endedMs = Date.now() - QUARANTINE_MS - 5_000;
    await leases.pool.query(
      `UPDATE node_leases SET lease_until = to_timestamp($2::bigint / 1000.0) WHERE node_id = $1`,
      [NODE, endedMs],
    );

    const grant = await leases.store.acquire(CLAIM);

    expect(grant).toMatchObject({ nodeId: NODE, prevUntilMs: endedMs });
    expect(grant?.leaseUntilMs).toBe((grant?.dbNowMs ?? 0) + CLAIM.ttlMs);
  });

  it('reports a node never leased as having no previous lease end', async () => {
    leases = await openLeaseDatabase();

    expect(await leases.store.acquire(CLAIM)).toMatchObject({ prevUntilMs: 0 });
  });

  it('makes a released node wait out the quarantine like an expired one', async () => {
    leases = await openLeaseDatabase();
    await holdAllNodesExcept(leases.pool, NODE);
    const grant = await leases.store.acquire(CLAIM);
    if (grant === null) throw new Error('no node');

    await leases.store.release({ ...grant, holder: CLAIM.holder, lastMs: Date.now() });

    expect(await leases.store.acquire(CLAIM)).toBeNull();
    const { rows } = await leases.pool.query<{ holder: string | null }>(
      'SELECT holder FROM node_leases WHERE node_id = $1',
      [NODE],
    );
    expect(rows[0]?.holder).toBeNull();
  });

  it("mints above the previous holder's last timestamp", async () => {
    const url = await freshDatabase();
    leases = await openLeaseDatabase(url);
    await holdAllNodesExcept(leases.pool, NODE);
    // A previous holder whose clock ran ahead, within what the lease accepts.
    const floorMs = Date.now() + 3_000;
    await leases.pool.query(
      `UPDATE node_leases SET generation = 5, max_ts_ms = $2, lease_until = now() - interval '1 millisecond'
       WHERE node_id = $1`,
      [NODE, floorMs],
    );

    app = await createTestApp(url, { ID_LEASE_QUARANTINE_MS: '0' });
    const res = await request(app.getHttpServer()).post('/v1/ids').send({ bucket: 1, count: 20 }).expect(200);

    for (const id of res.body.ids as string[]) {
      const fields = decode(id);
      expect(fields.nodeId).toBe(NODE);
      expect(fields.tsMs).toBeGreaterThan(floorMs);
    }
  });
});
