import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../../src/app.setup';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
// Every service built on the platform publishes these alongside its own.
const PLATFORM_ROUTE = / \/(health\/|metrics$)/;

// The routes moved from the api with their published contract; a client generated from the api's
// old document must find every one of them here, and nothing internal.
describe('Published API document (integration)', () => {
  let app: NestExpressApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = (await createTestAppWithPool()).app as NestExpressApplication;
    // The same builder main.ts serves at /docs.
    document = createOpenApiDocument(app);
  });
  closeAppAfterAll(() => app);

  const operations = (): string[] =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      HTTP_METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
    );

  it('documents exactly the eight order routes besides the platform ones', () => {
    expect(
      operations()
        .filter((operation) => !PLATFORM_ROUTE.test(operation))
        .sort(),
    ).toEqual(
      [
        'GET /admin/orders',
        'GET /admin/orders/{id}',
        'GET /orders',
        'GET /orders/{id}',
        'POST /admin/orders/{id}/cancel',
        'POST /orders',
        'POST /orders/{id}/cancel',
        'POST /orders/{id}/pay',
      ].sort(),
    );
  });

  it('tells a client that checkout and cancel can answer 503 with Retry-After', () => {
    for (const path of ['/orders', '/orders/{id}/cancel']) {
      const unavailable = document.paths[path].post?.responses['503'] as { headers?: Record<string, unknown> };
      expect(unavailable, path).toBeDefined();
      expect(unavailable.headers, path).toHaveProperty('Retry-After');
    }
  });
});
