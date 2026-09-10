import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v7 as uuidv7 } from 'uuid';
import { PASSWORD_HASHER, type PasswordHasherPort } from '@user/modules/user/application/ports/password-hasher.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '@user/modules/user/application/ports/user-repository.port';
import { AuthTokensService } from '@user/modules/user/application/services/auth-tokens.service';
import { User } from '@user/modules/user/domain/entities/user.entity';
import { authEpochKey } from '@shared/auth';
import { IdentityService, UNLEASED_NODE_ID, UuidV8Generator } from '@shared/identity';
import { RedisService } from '@shared/infrastructure/redis';
import { durationToMs, normalizeEmail } from '@shared/kernel';
import type { Role } from '@shared/rbac';
import { E2E_IDENTITY_BUCKET_KEY } from '../identity.helper';

let seq = 0;

// Built here rather than resolved from the app, for the same reason as `signer` below: commerce-core
// has no IdentityModule after the split, and a minted user's id must still route like a real one.
// It mints in the same process as a leased user-service, so it must not share that app's node id —
// and it cannot lease one, being module-level and synchronous. UNLEASED_NODE_ID is outside every
// pool by construction, which is the only id that stays safe here.
const identity = new IdentityService(UuidV8Generator.create({ nodeId: UNLEASED_NODE_ID }), E2E_IDENTITY_BUCKET_KEY);

// Stands in for the argon2 digest a real row would carry. Nothing verifies it: a minted user has no
// password to present, and a suite that needs one uses createRealTestUser.
const NO_PASSWORD_HASH = '$argon2id$minted-fixture-user-has-no-password';

export interface TestUserOptions {
  email?: string;
  password?: string;
  role?: Role;
  emailVerified?: boolean;
}

export interface TestUser {
  user: User;
  accessToken: string;
  password: string;
}

/**
 * Mints a token for a user that exists only as claims plus a Redis epoch — no `users` row. Legal
 * because no schema outside the user context references `users.id` by foreign key: `cart.user_id`,
 * `orders.user_id` and `media.uploaded_by` are plain uuid columns.
 *
 * This is all commerce-core ever sees of a user now that user-service holds the rows, so a suite
 * that goes red here is naming a coupling the split does not allow.
 */
export async function createTestUser(app: INestApplication, options: TestUserOptions = {}): Promise<TestUser> {
  const password = options.password ?? 'Password123!';
  // Same normalization as the register path, so a fixture user's id routes like a real one's.
  const email = normalizeEmail(options.email ?? `user-${Date.now()}-${seq++}@test.local`);
  const role = options.role ?? 'CUSTOMER';
  const id = identity.mintUserId(email);
  const epoch = 0;

  const config = app.get(ConfigService);
  await app
    .get(RedisService)
    .getClient()
    .set(authEpochKey(id), String(epoch), 'PX', durationToMs(config.getOrThrow<string>('auth.epochProjectionTtl')));

  // Same claim set the production signer emits: `email` is what checkout snapshots onto the order.
  const accessToken = await signer(config).signAsync({ sub: id, role, jti: uuidv7(), epoch, email });

  const now = new Date();
  const user = new User(id, email, NO_PASSWORD_HASH, role, now, now, options.emailVerified ? now : null, epoch);
  return { user, accessToken, password };
}

/**
 * A real row, hashed password and a token from the app's own issuer. Requires a **user-service** app
 * ({@link createUserApp}): the repositories and the signer it resolves live only there. Only for
 * suites that exercise the user context itself — registration, login, verification, reset, rotation,
 * session listing, id routing — where the row is the thing under test.
 */
export async function createRealTestUser(app: INestApplication, options: TestUserOptions = {}): Promise<TestUser> {
  const password = options.password ?? 'Password123!';
  const email = options.email ?? `user-${Date.now()}-${seq++}@test.local`;

  const hasher = app.get<PasswordHasherPort>(PASSWORD_HASHER);
  const users = app.get<UserRepositoryPort>(USER_REPOSITORY);
  const tokens = app.get(AuthTokensService);

  const passwordHash = await hasher.hash(password);
  let user = await users.create({ email: normalizeEmail(email), passwordHash, role: options.role });
  if (!user) {
    throw new Error(`Test user could not be created — email already taken: ${email}`);
  }
  if (options.emailVerified) {
    await users.markEmailVerified(user.id);
    user = (await users.findById(user.id)) ?? user;
  }
  const accessToken = await tokens.signAccess(user.id, user.role, user.email);

  return { user, accessToken, password };
}

export function createTestAdmin(app: INestApplication, options: Omit<TestUserOptions, 'role'> = {}): Promise<TestUser> {
  return createTestUser(app, { ...options, role: 'ADMIN' });
}

export function createRealTestAdmin(
  app: INestApplication,
  options: Omit<TestUserOptions, 'role'> = {},
): Promise<TestUser> {
  return createRealTestUser(app, { ...options, role: 'ADMIN' });
}

// Built per call rather than resolved from the app: the fixture signs the way user-service does,
// holding only the key. commerce-core has no AuthTokensService to borrow.
function signer(config: ConfigService): JwtService {
  return new JwtService({
    privateKey: config.getOrThrow<string>('auth.jwtPrivateKey'),
    signOptions: {
      algorithm: 'ES256',
      keyid: config.getOrThrow<string>('auth.jwtKeyId'),
      expiresIn: Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000),
    },
  });
}
