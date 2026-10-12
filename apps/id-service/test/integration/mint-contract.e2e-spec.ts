import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { MAX_IDS_PER_REQUEST } from '../../src/mint/mint.request';
import { sleep } from '../setup/eventually';
import { TestKeyspace } from '../setup/keyspaces';
import { createTestApp } from '../setup/test-app';

const GRACE_MS = 500;

describe('POST /v1/ids', () => {
  let keyspace: TestKeyspace;
  let app: INestApplication;
  let closing: Promise<void> | undefined;
  let nodeId: number;

  beforeAll(async () => {
    keyspace = await TestKeyspace.open();
    app = await createTestApp(keyspace.prefix, { SHUTDOWN_GRACE_PERIOD_MS: String(GRACE_MS) });
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    nodeId = ready.body.info.lease.nodeId as number;
  });

  afterAll(async () => {
    await (closing ?? app?.close());
    keyspace?.close();
  });

  const mint = (body: object, caller?: string) => {
    const req = request(app.getHttpServer()).post('/v1/ids');
    return (caller === undefined ? req : req.set('x-caller', caller)).send(body);
  };

  it('rejects every malformed request body with 400', async () => {
    const malformed: [string, object][] = [
      ['a count of 0', { count: 0 }],
      ['a fractional count', { count: 1.5 }],
      ['a count sent as a string', { count: '1' }],
      ['a count past the per-request cap', { count: MAX_IDS_PER_REQUEST + 1 }],
      ['an unknown field', { email: 'someone@example.com' }],
    ];

    const statuses: Record<string, number> = {};
    for (const [label, body] of malformed) statuses[label] = (await mint(body)).status;

    expect(statuses).toEqual(Object.fromEntries(malformed.map(([label]) => [label, 400])));
  });

  it('mints one id by default', async () => {
    const res = await mint({}).expect(200);
    expect(res.body.ids).toHaveLength(1);
  });

  it('mints the requested count, each under the held node', async () => {
    const res = await mint({ count: MAX_IDS_PER_REQUEST }, 'api').expect(200);
    const ids = res.body.ids as string[];

    expect(new Set(ids).size).toBe(MAX_IDS_PER_REQUEST);
    for (const id of ids) expect(decode(id)).toMatchObject({ nodeId });
  });

  it('exposes the lease and mint series on /metrics', async () => {
    await mint({ count: 3 }, 'user-service').expect(200);
    await mint({}, 'Not A Service').expect(200);

    const { text } = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(text).toContain('id_lease_state{state="held"} 1');
    expect(text).toContain(`id_lease_node_info{node_id="${nodeId}"} 1`);
    expect(text).toContain('id_minted_total{caller="user-service"} 3');
    expect(text).toContain('id_minted_total{caller="unknown"}');
    expect(text).toMatch(/^id_clock_drift_ms \d+/m);
  });

  it('keeps minting while draining, then releases the node with its floor brought down to its last id', async () => {
    closing = app.close();
    await sleep(GRACE_MS / 5);
    const res = await mint({}).expect(200);
    const lastMs = decode((res.body.ids as string[])[0] ?? '').tsMs;
    await closing;

    expect(await keyspace.owner(nodeId)).toBeUndefined();
    const floorMs = await keyspace.floor(nodeId);
    expect(floorMs).toBeGreaterThanOrEqual(lastMs);
    // Down from the ceiling a TTL ahead to what was really stamped.
    expect(floorMs).toBeLessThan(lastMs + 60_000);
  });
});
