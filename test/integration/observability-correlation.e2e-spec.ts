import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../setup/test-app.factory';

// Correlation-id behavior over the real HTTP stack (CLS middleware + pino). Uses the
// dependency-free public /health/live route so the test proves the correlation wiring in
// isolation — no DB/Redis, no auth. Covers Phase 1 DoD-4 (x-request-id header) and DoD-3
// (ALS does not leak the id between concurrent requests).
describe('Correlation id (integration)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    app = await createTestApp();
    // Bind an ephemeral port so parallel supertest requests hit an already-listening
    // server (firing concurrent requests at a non-listening server races on listen()).
    await app.listen(0);
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a generated x-request-id header when the client sends none (DoD-4)', async () => {
    const res = await request(server).get('/health/live').expect(200);
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('echoes a client-supplied x-request-id (lets a caller stitch its own trace id)', async () => {
    const supplied = 'client-trace-abc-123';
    const res = await request(server).get('/health/live').set('x-request-id', supplied).expect(200);
    expect(res.headers['x-request-id']).toBe(supplied);
  });

  it('keeps each concurrent request on its own id — the ALS context never leaks (DoD-3)', async () => {
    const suppliedIds = Array.from({ length: 8 }, (_v, i) => `concurrent-${i}`);

    const responses = await Promise.all(
      suppliedIds.map((id) => request(server).get('/health/live').set('x-request-id', id)),
    );

    // Every response must carry back exactly the id its own request sent — a leak would
    // surface as a response echoing a sibling request's id.
    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(suppliedIds[i]);
    });
  });

  it('generates a distinct id per request when several arrive concurrently without one', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(server).get('/health/live')));

    const ids = responses.map((res) => res.headers['x-request-id'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stamps the correlation id on a 4xx error envelope + header, keeping the legacy fields', async () => {
    // Empty body fails the ValidationPipe (400) before any handler/DB — exercises the
    // exception-filter enrichment path (DoD-5 foundation).
    const res = await request(server).post('/auth/register').send({}).expect(400);

    const headerId = res.headers['x-request-id'] as string;
    expect(typeof headerId).toBe('string');
    expect(res.body.requestId).toBe(headerId);
    // Backward-compat: the pre-existing envelope fields must still be present.
    expect(res.body).toMatchObject({ statusCode: 400, path: '/auth/register' });
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.message).toBeDefined();
  });

  it('serves the public /debug/boom route as a masked 5xx envelope (error pipeline)', async () => {
    // The debug endpoint throws on purpose; it is @Public() (reachable without a token) and gated
    // to non-prod. This drives the same filter path that reports to Sentry (a no-op without a DSN),
    // proving the 5xx envelope stays masked + correlated. Live Sentry.io delivery is verified
    // separately with a real DSN.
    const res = await request(server).get('/debug/boom').expect(500);

    const headerId = res.headers['x-request-id'] as string;
    expect(res.body.requestId).toBe(headerId);
    expect(res.body).toMatchObject({ statusCode: 500, path: '/debug/boom', message: 'Internal server error' });
    // The real error message must never leak to the client.
    expect(JSON.stringify(res.body)).not.toContain('Intentional boom');
  });
});
