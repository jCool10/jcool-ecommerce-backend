import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { User } from '../../domain/entities/user.entity';
import type { PasswordHasherPort } from '../ports/password-hasher.port';
import type { UserRepositoryPort } from '../ports/user-repository.port';
import type { SessionService } from '../services/session.service';
import { ChangePasswordUseCase } from './change-password.use-case';

// Hasher that encodes plaintext as `hashed:<plain>` so verify is deterministic.
class MockHasher implements PasswordHasherPort {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hashed:${plain}`);
  }
  verify(digest: string, plain: string): Promise<boolean> {
    return Promise.resolve(digest === `hashed:${plain}`);
  }
}

class MockUserRepo implements Partial<UserRepositoryPort> {
  user: User | null = User.create({
    id: 'u1',
    email: 'user@test.local',
    passwordHash: 'hashed:old-pw',
    role: 'CUSTOMER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  updated: Array<{ userId: string; passwordHash: string }> = [];

  findById(): Promise<User | null> {
    return Promise.resolve(this.user);
  }
  updatePassword(userId: string, passwordHash: string): Promise<void> {
    this.updated.push({ userId, passwordHash });
    return Promise.resolve();
  }
}

class MockSessions {
  revokedAllFor: string[] = [];
  revokeAll(userId: string): Promise<void> {
    this.revokedAllFor.push(userId);
    return Promise.resolve();
  }
}

describe('ChangePasswordUseCase', () => {
  let users: MockUserRepo;
  let hasher: MockHasher;
  let sessions: MockSessions;
  let useCase: ChangePasswordUseCase;

  beforeEach(() => {
    users = new MockUserRepo();
    hasher = new MockHasher();
    sessions = new MockSessions();
    useCase = new ChangePasswordUseCase(
      users as unknown as UserRepositoryPort,
      hasher,
      sessions as unknown as SessionService,
    );
  });

  it('verifies the current password, stores the new hash, and revokes every session', async () => {
    await useCase.execute({ userId: 'u1', currentPassword: 'old-pw', newPassword: 'new-password' });

    expect(users.updated).toEqual([{ userId: 'u1', passwordHash: 'hashed:new-password' }]);
    expect(sessions.revokedAllFor).toEqual(['u1']); // change-password = sign out everywhere
  });

  it('rejects a wrong current password with 401 and changes nothing', async () => {
    await expect(
      useCase.execute({ userId: 'u1', currentPassword: 'wrong-pw', newPassword: 'new-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(users.updated).toHaveLength(0);
    expect(sessions.revokedAllFor).toHaveLength(0);
  });

  it('rejects with 401 when the user no longer exists', async () => {
    users.user = null;

    await expect(
      useCase.execute({ userId: 'gone', currentPassword: 'old-pw', newPassword: 'new-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(users.updated).toHaveLength(0);
    expect(sessions.revokedAllFor).toHaveLength(0);
  });
});
