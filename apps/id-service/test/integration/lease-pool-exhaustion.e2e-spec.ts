import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { eventually } from '../setup/eventually';
import { TestKeyspace } from '../setup/keyspaces';
import { createTestApp } from '../setup/test-app';

describe('an exhausted node pool', () => {
  let keyspace: TestKeyspace;
  let app: INestApplication;

  beforeAll(async () => {
    keyspace = await TestKeyspace.open();
    await keyspace.holdAllNodesExcept();
    app = await createTestApp(keyspace.prefix);
  });

  afterAll(async () => {
    await app?.close();
    keyspace?.close();
  });

  it('keeps the replica alive but not ready', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(ready.body.error).toEqual({ lease: { status: 'down', state: 'exhausted' } });
  });

  it('refuses to mint with LEASE_NOT_HELD', async () => {
    const res = await request(app.getHttpServer()).post('/v1/ids').send({}).expect(503);
    expect(res.body).toMatchObject({ statusCode: 503, code: 'LEASE_NOT_HELD' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('recovers on its own once a node frees up', async () => {
    await keyspace.expire(7);

    await eventually(async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      return res.status === 200 ? res : undefined;
    });
    const res = await request(app.getHttpServer()).post('/v1/ids').send({}).expect(200);
    expect(decode((res.body.ids as string[])[0] ?? '').nodeId).toBe(7);
  });
});
