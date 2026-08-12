import { ConflictException } from '@nestjs/common';
import { User } from '../../domain/entities/user.entity';
import type { PasswordHasherPort } from '../ports/password-hasher.port';
import type { CreateUserInput, UserRepositoryPort } from '../ports/user-repository.port';
import { RegisterUserUseCase } from './register-user.use-case';

class MockUserRepository implements UserRepositoryPort {
  existing: User | null = null;
  lastFindEmail?: string;
  created?: CreateUserInput;

  findByEmail(email: string): Promise<User | null> {
    this.lastFindEmail = email;
    return Promise.resolve(this.existing);
  }
  findById(): Promise<User | null> {
    return Promise.resolve(null);
  }
  create(input: CreateUserInput): Promise<User> {
    this.created = input;
    return Promise.resolve(
      new User('new-id', input.email, input.passwordHash, input.role ?? 'CUSTOMER', new Date(), new Date()),
    );
  }
}

const hasher: PasswordHasherPort = {
  hash: (plain: string) => Promise.resolve(`hashed:${plain}`),
  verify: (hash: string, plain: string) => Promise.resolve(hash === `hashed:${plain}`),
};

describe('RegisterUserUseCase', () => {
  let repo: MockUserRepository;
  let useCase: RegisterUserUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    useCase = new RegisterUserUseCase(repo, hasher);
  });

  it('hashes the password and creates a user when the email is free', async () => {
    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(repo.created).toEqual({ email: 'user@example.com', passwordHash: 'hashed:supersecret' });
    expect(repo.created?.role).toBeUndefined(); // DB default CUSTOMER applies
    expect(user.email).toBe('user@example.com');
    expect(user.role).toBe('CUSTOMER');
  });

  it('normalizes the email (trim + lowercase) before lookup and create', async () => {
    await useCase.execute({ email: '  User@Example.COM  ', password: 'supersecret' });

    expect(repo.lastFindEmail).toBe('user@example.com');
    expect(repo.created?.email).toBe('user@example.com');
  });

  it('throws ConflictException and does not create when the email is taken', async () => {
    repo.existing = new User('u1', 'user@example.com', 'hashed:x', 'CUSTOMER', new Date(), new Date());

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.created).toBeUndefined();
  });
});
