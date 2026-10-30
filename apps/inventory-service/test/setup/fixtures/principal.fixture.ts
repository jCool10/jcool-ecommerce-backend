import type { INestApplication } from '@nestjs/common';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { LEASED_NODE_MAX, SnowflakeGenerator } from '@jcool/id-generator';
import type { Role } from '@jcool/platform/rbac';
import { RedisService } from '@jcool/platform/redis';
import { type StubUser, userServiceStub } from '../user-service-stub';

// Stands in for the user-service's own generator, which mints on a leased node id.
const ids = SnowflakeGenerator.create({ nodeId: LEASED_NODE_MAX });

export interface TestPrincipal {
  user: StubUser;
  accessToken: string;
}

/** An ES256 token from the stub's key, an epoch in Redis, and an entry in the stub's directory. */
export async function createTestPrincipal(app: INestApplication, role: Role = 'CUSTOMER'): Promise<TestPrincipal> {
  const user: StubUser = { id: ids.generate(), role };
  const stub = await userServiceStub();
  stub.register(user);
  await app
    .get(RedisService)
    .getClient()
    .set(SESSION_EPOCH_KEY_PREFIX + user.id, '0');
  return { user, accessToken: await stub.sign(user) };
}

export function createTestAdminPrincipal(app: INestApplication): Promise<TestPrincipal> {
  return createTestPrincipal(app, 'ADMIN');
}
