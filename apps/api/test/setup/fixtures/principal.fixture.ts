import type { INestApplication } from '@nestjs/common';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { bucketForEmail } from '@jcool/id-codec';
import { LEASED_NODE_MAX, SnowflakeGenerator } from '@jcool/id-generator';
import { normalizeEmail } from '@jcool/kernel';
import type { Role } from '@jcool/platform/rbac';
import { RedisService } from '@jcool/platform/redis';
import { type StubUser, userServiceStub } from '../user-service-stub';

// Stands in for the user-service's own generator, which mints on a leased node id. The bucket key is
// the user-service's now; this one only has to be stable so a user's id and its rows agree.
const BUCKET_KEY = 'e2e-identity-bucket-key-not-a-real-secret-000';
const ids = SnowflakeGenerator.create({ nodeId: LEASED_NODE_MAX });
let seq = 0;

export interface TestPrincipalOptions {
  email?: string;
  role?: Role;
}

/** An id the user-service could have minted, for a caller this api is not meant to know yet. */
export function mintTestUserId(email: string): string {
  const normalized = normalizeEmail(email);
  return ids.generate(bucketForEmail(normalized, BUCKET_KEY));
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
    id: ids.generate(bucketForEmail(email, BUCKET_KEY)),
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
