import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { MAX_IDS_PER_REQUEST } from '../../src/mint/mint.request';
import { freshDatabase, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';
import { sleep } from '../setup/eventually';
import { createTestApp } from '../setup/test-app';

const GRACE_MS = 500;

describe('POST /v1/ids', () => {
  let leases: LeaseDatabase;
  let app: INestApplication;
  let closing: Promise<void> | undefined;
  let nodeId: number;

  beforeAll(async () => {
    const url = await freshDatabase();
    leases = await openLeaseDatabase(url);
    app = await createTestApp(url, { SHUTDOWN_GRACE_PERIOD_MS: String(GRACE_MS) });
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    nodeId = ready.body.info.lease.nodeId as number;
  });

  afterAll(async () => {
    await (closing ?? app?.close());
    await leases?.close();
  });

  const mint = (body: object, caller?: string) => {
    const req = request(app.getHttpServer()).post('/v1/ids');
    return (caller === undefined ? req : req.set('x-caller', caller)).send(body);
  };

  it('rejects every malformed request body with 400', async () => {
    const malformed: [string, object][] = [
      ['a missing bucket', { count: 1 }],
      ['a negative bucket', { bucket: -1 }],
      ['a bucket past 4095', { bucket: 4096 }],
      ['a fractional bucket', { bucket: 1.5 }],
      ['a bucket sent as a string', { bucket: '1' }],
      ['a count of 0', { bucket: 1, count: 0 }],
      ['a count past the per-request cap', { bucket: 1, count: MAX_IDS_PER_REQUEST + 1 }],
      ['an unknown field', { bucket: 1, email: 'someone@example.com' }],
    ];

    const statuses: Record<string, number> = {};
    for (const [label, body] of malformed) statuses[label] = (await mint(body)).status;

    expect(statuses).toEqual(Object.fromEntries(malformed.map(([label]) => [label, 400])));
  });

  it('mints one id by default', async () => {
    const res = await mint({ bucket: 9 }).expect(200);
    expect(res.body.ids).toHaveLength(1);
  });

  it('mints the requested count, each under the held node and the requested bucket', async () => {
    const res = await mint({ bucket: 4095, count: MAX_IDS_PER_REQUEST }, 'api').expect(200);
    const ids = res.body.ids as string[];

    expect(new Set(ids).size).toBe(MAX_IDS_PER_REQUEST);
    for (const id of ids) expect(decode(id)).toMatchObject({ nodeId, bucket: 4095 });
  });

  it('exposes the lease and mint series on /metrics', async () => {
    await mint({ bucket: 1, count: 3 }, 'user-service').expect(200);
    await mint({ bucket: 1 }, 'Not A Service').expect(200);

    const { text } = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(text).toContain('id_lease_state{state="held"} 1');
    expect(text).toContain(`id_lease_node_info{node_id="${nodeId}"} 1`);
    expect(text).toContain('id_minted_total{caller="user-service"} 3');
    expect(text).toContain('id_minted_total{caller="unknown"}');
    expect(text).toMatch(/^id_clock_drift_ms \d+/m);
  });

  it('keeps minting while draining, then releases the node with its last timestamp', async () => {
    closing = app.close();
    await sleep(GRACE_MS / 5);
    const res = await mint({ bucket: 2 }).expect(200);
    const lastMs = decode((res.body.ids as string[])[0] ?? '').tsMs;
    await closing;

    const { rows } = await leases.pool.query<{ holder: string | null; max_ts_ms: string; live: boolean }>(
      'SELECT holder, max_ts_ms, lease_until > now() AS live FROM node_leases WHERE node_id = $1',
      [nodeId],
    );
    expect(rows[0]).toMatchObject({ holder: null, live: false });
    expect(Number(rows[0]?.max_ts_ms)).toBeGreaterThanOrEqual(lastMs);
  });
});
