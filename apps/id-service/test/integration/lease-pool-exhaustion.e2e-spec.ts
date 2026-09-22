import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { freshDatabase, holdAllNodesExcept, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';
import { eventually } from '../setup/eventually';
import { createTestApp } from '../setup/test-app';

describe('an exhausted node pool', () => {
  let leases: LeaseDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    const url = await freshDatabase();
    leases = await openLeaseDatabase(url);
    await holdAllNodesExcept(leases.pool);
    app = await createTestApp(url, { ID_LEASE_QUARANTINE_MS: '0' });
  });

  afterAll(async () => {
    await app?.close();
    await leases?.close();
  });

  it('keeps the replica alive but not ready', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(ready.body.error).toEqual({ lease: { status: 'down', state: 'exhausted' } });
  });

  it('refuses to mint with LEASE_NOT_HELD', async () => {
    const res = await request(app.getHttpServer()).post('/v1/ids').send({ bucket: 0 }).expect(503);
    expect(res.body).toMatchObject({ statusCode: 503, code: 'LEASE_NOT_HELD' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('recovers on its own once a node frees up', async () => {
    await leases.pool.query(`UPDATE node_leases SET lease_until = now() - interval '1 second' WHERE node_id = 7`);

    await eventually(async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      return res.status === 200 ? res : undefined;
    });
    const res = await request(app.getHttpServer()).post('/v1/ids').send({ bucket: 0 }).expect(200);
    expect(decode((res.body.ids as string[])[0] ?? '').nodeId).toBe(7);
  });
});
