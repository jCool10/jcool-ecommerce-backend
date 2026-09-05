import type { INestApplication } from '@nestjs/common';
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
import { normalizeEmail } from '../../../src/shared/kernel/normalize-email';
import type { Role } from '../../../src/shared/rbac/role.enum';

let seq = 0; // keeps generated emails unique within a run

export interface TestUserOptions {
  email?: string;
  password?: string;
  role?: Role;
  /** Stamp the account as email-verified after creation (default false). */
  emailVerified?: boolean;
}

export interface TestUser {
  user: User;
  accessToken: string;
  password: string;
}

// Persists a user via the real hasher + repository, then mints an access token.
export async function createTestUser(app: INestApplication, options: TestUserOptions = {}): Promise<TestUser> {
  const password = options.password ?? 'Password123!';
  const email = options.email ?? `user-${Date.now()}-${seq++}@test.local`;

  const hasher = app.get<PasswordHasherPort>(PASSWORD_HASHER);
  const users = app.get<UserRepositoryPort>(USER_REPOSITORY);
  const tokens = app.get(AuthTokensService);

  const passwordHash = await hasher.hash(password);
  // Same normalization as the register path, so a fixture user's id routes like a real one's.
  let user = await users.create({ email: normalizeEmail(email), passwordHash, role: options.role });
  if (!user) {
    throw new Error(`Test user could not be created — email already taken: ${email}`);
  }
  if (options.emailVerified) {
    await users.markEmailVerified(user.id);
    user = (await users.findById(user.id)) ?? user; // reflect the verified stamp
  }
  const accessToken = await tokens.signAccess(user.id, user.role);

  return { user, accessToken, password };
}

export function createTestAdmin(app: INestApplication, options: Omit<TestUserOptions, 'role'> = {}): Promise<TestUser> {
  return createTestUser(app, { ...options, role: 'ADMIN' });
}
