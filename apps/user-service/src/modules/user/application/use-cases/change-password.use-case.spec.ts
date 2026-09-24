import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { User } from '../../domain/entities/user.entity';
import { PlainPasswordHasher } from '../../testing/plain-password-hasher.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeSessionEpoch } from '../../testing/session-epoch.double';
import { FakeUserRepository } from '../../testing/user-repository.double';
import { SessionService } from '../services';
import { ChangePasswordUseCase } from './change-password.use-case';

describe('ChangePasswordUseCase', () => {
  let log: string[];
  let users: FakeUserRepository;
  let refreshTokens: FakeRefreshTokenRepository;
  let useCase: ChangePasswordUseCase;

  beforeEach(() => {
    log = [];
    users = new FakeUserRepository(log);
    users.user = User.create({
      id: 'u1',
      email: 'user@test.local',
      passwordHash: 'hashed:old-pw',
      role: 'CUSTOMER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    refreshTokens = new FakeRefreshTokenRepository(log);
    useCase = new ChangePasswordUseCase(
      users,
      new PlainPasswordHasher(),
      new SessionService(refreshTokens, new FakeSessionEpoch(log)),
    );
  });

  // Not one transaction, so revoking first fails safe: a crash leaves the old password with no sessions.
  it('revokes every session, then stores the new hash', async () => {
    await useCase.execute({ userId: 'u1', currentPassword: 'old-pw', newPassword: 'new-password' });

    expect(refreshTokens.revokedAllFor).toEqual(['u1']);
    expect(users.passwordUpdates).toEqual([{ userId: 'u1', passwordHash: 'hashed:new-password' }]);
    expect(log).toEqual(['revokeAllForUser', 'bump', 'updatePassword']);
  });

  // Otherwise anyone holding a stolen access token could sign every other session out.
  it('rejects a wrong current password with 401 and changes nothing', async () => {
    await expect(
      useCase.execute({ userId: 'u1', currentPassword: 'wrong-pw', newPassword: 'new-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(log).toEqual([]);
  });

  it('rejects with 401 when the user no longer exists', async () => {
    users.user = null;

    await expect(
      useCase.execute({ userId: 'gone', currentPassword: 'old-pw', newPassword: 'new-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(log).toEqual([]);
  });
});
