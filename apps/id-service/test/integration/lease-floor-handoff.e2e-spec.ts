import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import type { LeaseGrant } from '@jcool/id-generator';
import { TestKeyspace } from '../setup/keyspaces';
import { createTestApp } from '../setup/test-app';

const NODE = 21;
const TTL_MS = 60_000;
const CLAIM = { holder: 'claimant', ttlMs: TTL_MS };

describe('the floor a node carries from one holder to the next', () => {
  let keyspace: TestKeyspace | undefined;
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    keyspace?.close();
    app = keyspace = undefined;
  });

  async function onlyNodeFree(): Promise<TestKeyspace> {
    keyspace = await TestKeyspace.open();
    await keyspace.holdAllNodesExcept(NODE);
    return keyspace;
  }

  async function claim(on: TestKeyspace): Promise<LeaseGrant> {
    const grant = await on.store().acquire(CLAIM);
    if (grant === null) throw new Error('no node');
    return grant;
  }

  it('reports a node never leased as having no floor', async () => {
    keyspace = await TestKeyspace.open();

    expect(await keyspace.store().acquire(CLAIM)).toMatchObject({ floorMs: null });
  });

  it('reserves a ceiling one TTL ahead and records it as the floor', async () => {
    const on = await onlyNodeFree();

    const grant = await claim(on);

    expect(grant).toMatchObject({ nodeId: NODE, floorMs: null });
    expect(grant.leaseUntilMs).toBe(grant.nowMs + TTL_MS);
    expect(await on.floor(NODE)).toBe(grant.leaseUntilMs);
  });

  // A holder that died between renewals never reported its last ids, and its clock may have run
  // ahead of this one. Neither matters: it never stamped past its ceiling, and this holder starts above it.
  it('starts the next holder above the ceiling the previous one reserved', async () => {
    const on = await onlyNodeFree();
    const first = await claim(on);
    await on.expire(NODE);

    const second = await claim(on);

    expect(second).toMatchObject({ nodeId: NODE, floorMs: first.leaseUntilMs });
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.leaseUntilMs).toBe(Math.max(second.nowMs, first.leaseUntilMs) + TTL_MS);
  });

  it('refuses a renewal once the lease is gone, leaving the reserved ceiling in place', async () => {
    const on = await onlyNodeFree();
    const grant = await claim(on);
    await on.expire(NODE);

    expect(await on.store().renew({ ...grant, holder: CLAIM.holder, ttlMs: TTL_MS, lastMs: Date.now() })).toBeNull();

    expect(await on.floor(NODE)).toBe(grant.leaseUntilMs);
  });

  it('never lowers the ceiling on renew, even for a clock that stepped back', async () => {
    const on = await onlyNodeFree();
    const grant = await claim(on);

    const renewed = await on.store().renew({ ...grant, holder: CLAIM.holder, ttlMs: 1_000, lastMs: 0 });

    expect(renewed).toBe(grant.leaseUntilMs);
  });

  it('brings the floor down to the last minted timestamp on release, never below the one it claimed above', async () => {
    const on = await onlyNodeFree();
    const claimedAboveMs = Date.now() - 60_000;
    await on.setFloor(NODE, claimedAboveMs);
    const first = await claim(on);
    expect(first.floorMs).toBe(claimedAboveMs);

    const lastMs = Date.now();
    await on.store().release({ ...first, holder: CLAIM.holder, lastMs });
    expect(await on.owner(NODE)).toBeUndefined();
    expect(await on.floor(NODE)).toBe(lastMs);

    const second = await claim(on);
    expect(second.floorMs).toBe(lastMs);
    await on.store().release({ ...second, holder: CLAIM.holder, lastMs: null });
    expect(await on.floor(NODE)).toBe(lastMs);
  });

  it("mints above the previous holder's ceiling", async () => {
    const on = await onlyNodeFree();
    // A previous holder whose clock ran ahead, within what the lease accepts.
    const floorMs = Date.now() + 3_000;
    await on.setFloor(NODE, floorMs);

    app = await createTestApp(on.prefix);
    const res = await request(app.getHttpServer()).post('/v1/ids').send({ count: 20 }).expect(200);

    for (const id of res.body.ids as string[]) {
      const fields = decode(id);
      expect(fields.nodeId).toBe(NODE);
      expect(fields.tsMs).toBeGreaterThan(floorMs);
    }
  });
});
