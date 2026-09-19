import type { INestApplication } from '@nestjs/common';
import { normalizeEmail } from '@jcool/kernel';
import type { Role } from '@jcool/platform/rbac';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../../../src/modules/user/application/ports/password-hasher.port';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../../src/modules/user/application/ports/user-repository.port';
import { AuthTokensService } from '../../../src/modules/user/application/services/auth-tokens.service';
import type { User } from '../../../src/modules/user/domain/entities/user.entity';

let seq = 0;

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

/** Straight through the repository: no signup mail, and no epoch published to Redis. */
export async function createTestUser(app: INestApplication, options: TestUserOptions = {}): Promise<TestUser> {
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
  const accessToken = await tokens.signAccess(user.id, user.role, user.tokenEpoch);

  return { user, accessToken, password };
}

export function createTestAdmin(app: INestApplication, options: Omit<TestUserOptions, 'role'> = {}): Promise<TestUser> {
  return createTestUser(app, { ...options, role: 'ADMIN' });
}
