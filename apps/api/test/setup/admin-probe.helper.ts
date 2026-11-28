import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authHeader } from './bearer.helper';
import { createTestProduct } from './fixtures/catalog.fixture';

/** Also the `route` label the throttler and the HTTP metrics give it. */
export const ADMIN_PROBE_ROUTE = '/admin/products/:productId/images';

export const adminProbePath = (productId: string): string => ADMIN_PROBE_ROUTE.replace(':productId', productId);

/**
 * The api serves no buyer route, so a signed-in caller is probed on an admin read: the throttler and
 * the token guard (epoch, denylist) both run before the role check, and an admin's token answers 200.
 * Seeds a product to read, so build it after any database reset.
 */
export async function createAdminProbe(app: INestApplication): Promise<(token: string) => request.Test> {
  const path = adminProbePath((await createTestProduct(app)).productId);
  return (token) => request(app.getHttpServer()).get(path).set(authHeader(token));
}
