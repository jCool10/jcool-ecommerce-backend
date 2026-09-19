import { ConflictException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { User } from '../../domain/entities/user.entity';
import type { CreateUserInput, PasswordHasherPort, SessionEpochPublisherPort, UserRepositoryPort } from '../ports';
import type { EmailVerificationService, VerificationRecipient } from '../services';
import { RegisterUserUseCase } from './register-user.use-case';

class MockUserRepository implements UserRepositoryPort {
  // When set, create() returns null — the unique-index conflict an already-taken email produces.
  emailTaken = false;
  created?: CreateUserInput;

  findByEmail(): Promise<User | null> {
    return Promise.resolve(null);
  }
  findById(): Promise<User | null> {
    return Promise.resolve(null);
  }
  create(input: CreateUserInput): Promise<User | null> {
    if (this.emailTaken) {
      return Promise.resolve(null);
    }
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
  let publish: Mock<SessionEpochPublisherPort['publish']>;
  let warn: Mock;
  let useCase: RegisterUserUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    emailVerification = new MockEmailVerification();
    publish = vi.fn<SessionEpochPublisherPort['publish']>().mockResolvedValue(0);
    warn = vi.fn();
    useCase = new RegisterUserUseCase(
      repo,
      hasher,
      emailVerification as unknown as EmailVerificationService,
      { publish },
      fakePinoLogger({ warn }),
    );
  });

  it("publishes the new user's epoch", async () => {
    await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(publish).toHaveBeenCalledExactlyOnceWith('new-id', 0);
  });

  it('still registers when the epoch cannot be published', async () => {
    publish.mockRejectedValue(new Error('Connection is closed.'));

    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(user.id).toBe('new-id');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { userId: 'new-id', err: expect.any(Error) as Error },
      'session epoch not published at signup',
    );
  });

  it('publishes nothing when the email is taken', async () => {
    repo.emailTaken = true;

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('hashes the password and creates a user when the email is free', async () => {
    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(repo.created).toEqual({ email: 'user@example.com', passwordHash: 'hashed:supersecret' });
    expect(repo.created?.role).toBeUndefined(); // DB default CUSTOMER applies
    expect(user.email).toBe('user@example.com');
    expect(user.role).toBe('CUSTOMER');
    expect(user.isEmailVerified).toBe(false);
  });

  it('issues + sends a verification token for the new user', async () => {
    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(emailVerification.sentTo).toEqual([user]);
  });

  it('normalizes the email (trim + lowercase) before create', async () => {
    await useCase.execute({ email: '  User@Example.COM  ', password: 'supersecret' });

    expect(repo.created?.email).toBe('user@example.com');
  });

  it('throws ConflictException and sends no email when the insert loses the race (create → null)', async () => {
    repo.emailTaken = true;

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.created).toBeUndefined();
    expect(emailVerification.sentTo).toHaveLength(0);
  });

  it('still returns the created user when the verification mailer throws (after-commit, non-fatal)', async () => {
    emailVerification.issueAndSend = () => Promise.reject(new Error('smtp down'));

    const user = await useCase.execute({ email: 'user@example.com', password: 'supersecret' });

    expect(user.email).toBe('user@example.com');
    expect(repo.created?.email).toBe('user@example.com');
  });
});
