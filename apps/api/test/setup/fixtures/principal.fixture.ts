import type { INestApplication } from '@nestjs/common';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { bucketForEmail } from '@jcool/id-codec';
import { LEASED_NODE_MAX, UuidV8Generator } from '@jcool/id-generator';
import { normalizeEmail } from '@jcool/kernel';
import type { Role } from '@jcool/platform/rbac';
import { RedisService } from '@jcool/platform/redis';
import { E2E_IDENTITY_BUCKET_KEY } from '../e2e-constants';
import { type StubUser, userServiceStub } from '../user-service-stub';

// Stands in for the user-service's own generator, which mints on a leased node id.
const ids = UuidV8Generator.create({ nodeId: LEASED_NODE_MAX });
let seq = 0;

export interface TestPrincipalOptions {
  email?: string;
  role?: Role;
}

export interface TestPrincipal {
  user: StubUser;
  accessToken: string;
}

/**
 * A caller as the api sees one after the cutover: an ES256 token, an epoch in Redis, and an entry in
 * the user directory — and no row in this database. All three in one call, or a suite that reaches
 * `order.paid` dead-letters its confirmation on a user the directory has never heard of.
 */
export async function createTestPrincipal(
  app: INestApplication,
  options: TestPrincipalOptions = {},
): Promise<TestPrincipal> {
  const email = normalizeEmail(options.email ?? `principal-${Date.now()}-${seq++}@test.local`);
  const user: StubUser = {
    id: ids.generate(bucketForEmail(email, E2E_IDENTITY_BUCKET_KEY)),
    email,
    role: options.role ?? 'CUSTOMER',
  };

  const stub = await userServiceStub();
  stub.register(user);
  await app
    .get(RedisService)
    .getClient()
    .set(SESSION_EPOCH_KEY_PREFIX + user.id, '0');
  return { user, accessToken: await stub.sign(user) };
}

export function createTestAdminPrincipal(
  app: INestApplication,
  options: Omit<TestPrincipalOptions, 'role'> = {},
): Promise<TestPrincipal> {
  return createTestPrincipal(app, { ...options, role: 'ADMIN' });
}

/** For the suites that only ever need a fresh caller. */
export async function newPrincipalToken(app: INestApplication, options: TestPrincipalOptions = {}): Promise<string> {
  return (await createTestPrincipal(app, options)).accessToken;
}
