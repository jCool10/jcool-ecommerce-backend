import { describe, expect, it, vi } from 'vitest';
import { Role } from '@shared/rbac';
import { User } from '../domain/entities/user.entity';
import type { UserRepositoryPort } from '../application/ports';
import { UserFacadeAdapter } from './user-facade.adapter';

function build(user: User | null) {
  const findById = vi.fn().mockResolvedValue(user);
  return new UserFacadeAdapter({ findById } as unknown as UserRepositoryPort);
}

const USER = User.create({
  id: '0198f0d8-1111-8000-8000-000000000001',
  email: 'buyer@test.local',
  passwordHash: '$argon2id$not-a-real-hash',
  role: Role.Customer,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('UserFacadeAdapter', () => {
  it('publishes id, email and role — and nothing else', async () => {
    const summary = await build(USER).getUserSummary(USER.id);

    expect(summary).toEqual({ id: USER.id, email: 'buyer@test.local', role: Role.Customer });
    expect(JSON.stringify(summary)).not.toContain('argon2');
  });

  it('answers null for an id nobody owns', async () => {
    await expect(build(null).getUserSummary(USER.id)).resolves.toBeNull();
  });
});
