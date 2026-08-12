import { UnauthorizedException } from '@nestjs/common';
import { User } from '../../domain/entities/user.entity';
import type { UserRepositoryPort } from '../ports/user-repository.port';
import { GetProfileUseCase } from './get-profile.use-case';

class MockUserRepository implements UserRepositoryPort {
  findByIdCalls: string[] = [];

  constructor(private readonly user: User | null) {}

  findById(id: string): Promise<User | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.user);
  }

  findByEmail(): Promise<User | null> {
    return Promise.resolve(null);
  }

  create(): Promise<User> {
    throw new Error('not used in these tests');
  }
}

function makeUser(): User {
  const now = new Date('2026-01-01T00:00:00Z');
  return User.create({
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: '$argon2id$hash',
    role: 'CUSTOMER',
    createdAt: now,
    updatedAt: now,
  });
}

describe('GetProfileUseCase', () => {
  it('returns the user for a valid id', async () => {
    const user = makeUser();
    const repo = new MockUserRepository(user);
    const useCase = new GetProfileUseCase(repo);

    await expect(useCase.execute('user-1')).resolves.toBe(user);
    expect(repo.findByIdCalls).toEqual(['user-1']);
  });

  it('throws 401 when the token is valid but the user no longer exists', async () => {
    const repo = new MockUserRepository(null);
    const useCase = new GetProfileUseCase(repo);

    await expect(useCase.execute('ghost-user')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
