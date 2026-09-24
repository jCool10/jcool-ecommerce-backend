import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeAppAfterAll } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

describe('Correlation id (integration)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer() as Server;
  });
  closeAppAfterAll(() => app);

  it('echoes a client-supplied x-request-id', async () => {
    const supplied = 'client-trace-abc-123';
    const res = await request(server).get('/health/live').set('x-request-id', supplied).expect(200);
    expect(res.headers['x-request-id']).toBe(supplied);
  });

  it('keeps each concurrent request on its own supplied id', async () => {
    const suppliedIds = Array.from({ length: 8 }, (_v, i) => `concurrent-${i}`);

    const responses = await Promise.all(
      suppliedIds.map((id) => request(server).get('/health/live').set('x-request-id', id)),
    );

    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(suppliedIds[i]);
    });
  });

  it('generates a distinct id per request when several arrive concurrently without one', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(server).get('/health/live')));

    const ids = responses.map((res) => res.headers['x-request-id']);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stamps the correlation id on a 4xx error envelope and keeps its fields', async () => {
    const res = await request(server).get('/products?page=0').expect(400);

    const headerId = res.headers['x-request-id'];
    expect(typeof headerId).toBe('string');
    expect(res.body.requestId).toBe(headerId);
    expect(res.body).toMatchObject({ statusCode: 400, path: '/products?page=0' });
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.message).toBeDefined();
  });

  it('masks a 5xx from /debug/boom and stamps the correlation id on it', async () => {
    const res = await request(server).get('/debug/boom').expect(500);

    const headerId = res.headers['x-request-id'];
    expect(res.body.requestId).toBe(headerId);
    expect(res.body).toMatchObject({ statusCode: 500, path: '/debug/boom', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('Intentional boom');
  });
});
