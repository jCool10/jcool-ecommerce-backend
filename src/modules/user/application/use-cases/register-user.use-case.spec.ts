import { ConflictException } from '@nestjs/common';
import { User } from '../../domain/entities/user.entity';
import type { CreateUserInput, PasswordHasherPort, UserRepositoryPort } from '../ports';
import type { EmailVerificationService, VerificationRecipient } from '../services';
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
  markEmailVerified(): Promise<void> {
    return Promise.resolve();
  }
  updatePassword(): Promise<void> {
    return Promise.resolve();
  }
}

// Captures who a verification token was issued + sent for.
class MockEmailVerification {
  sentTo: VerificationRecipient[] = [];
  issueAndSend(recipient: VerificationRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return Promise.resolve();
  }
}

const hasher: PasswordHasherPort = {
  hash: (plain: string) => Promise.resolve(`hashed:${plain}`),
  verify: (hash: string, plain: string) => Promise.resolve(hash === `hashed:${plain}`),
};

describe('RegisterUserUseCase', () => {
  let repo: MockUserRepository;
  let emailVerification: MockEmailVerification;
  let useCase: RegisterUserUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    emailVerification = new MockEmailVerification();
    useCase = new RegisterUserUseCase(repo, hasher, emailVerification as unknown as EmailVerificationService);
  });

  it('hashes the password and creates a user when the email is free', async () => {
    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(repo.created).toEqual({ email: 'user@example.com', passwordHash: 'hashed:supersecret' });
    expect(repo.created?.role).toBeUndefined(); // DB default CUSTOMER applies
    expect(user.email).toBe('user@example.com');
    expect(user.role).toBe('CUSTOMER');
    expect(user.isEmailVerified).toBe(false); // new accounts start unverified
  });

  it('issues + sends a verification token for the new user', async () => {
    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(emailVerification.sentTo).toEqual([user]);
  });

  it('normalizes the email (trim + lowercase) before lookup and create', async () => {
    await useCase.execute({ email: '  User@Example.COM  ', password: 'supersecret' });

    expect(repo.lastFindEmail).toBe('user@example.com');
    expect(repo.created?.email).toBe('user@example.com');
  });

  it('throws ConflictException, does not create, and sends no email when the email is taken', async () => {
    repo.existing = new User('u1', 'user@example.com', 'hashed:x', 'CUSTOMER', new Date(), new Date());

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.created).toBeUndefined();
    expect(emailVerification.sentTo).toHaveLength(0);
  });
});
