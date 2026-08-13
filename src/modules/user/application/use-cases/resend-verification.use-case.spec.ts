import { beforeEach, describe, expect, it } from 'vitest';
import { User } from '../../domain/entities/user.entity';
import type { UserRepositoryPort } from '../ports/user-repository.port';
import type { EmailVerificationService, VerificationRecipient } from '../services/email-verification.service';
import { ResendVerificationUseCase } from './resend-verification.use-case';

function makeUser(emailVerifiedAt: Date | null): User {
  return new User('u1', 'user@example.com', 'hash', 'CUSTOMER', new Date(), new Date(), emailVerifiedAt);
}

class MockUserRepository implements Partial<UserRepositoryPort> {
  user: User | null = null;
  lastFindEmail?: string;
  findByEmail(email: string): Promise<User | null> {
    this.lastFindEmail = email;
    return Promise.resolve(this.user);
  }
}

class MockEmailVerification {
  sentTo: VerificationRecipient[] = [];
  issueAndSend(recipient: VerificationRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return Promise.resolve();
  }
}

describe('ResendVerificationUseCase', () => {
  let repo: MockUserRepository;
  let emailVerification: MockEmailVerification;
  let useCase: ResendVerificationUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    emailVerification = new MockEmailVerification();
    useCase = new ResendVerificationUseCase(
      repo as unknown as UserRepositoryPort,
      emailVerification as unknown as EmailVerificationService,
    );
  });

  it('issues a fresh token for an existing, still-unverified account', async () => {
    repo.user = makeUser(null);

    await useCase.execute('user@example.com');

    expect(emailVerification.sentTo).toEqual([repo.user]);
  });

  it('is a silent no-op for an already-verified account (no email)', async () => {
    repo.user = makeUser(new Date());

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
    expect(emailVerification.sentTo).toHaveLength(0);
  });

  it('is a silent no-op for an unknown address (no enumeration)', async () => {
    repo.user = null;

    await expect(useCase.execute('nobody@example.com')).resolves.toBeUndefined();
    expect(emailVerification.sentTo).toHaveLength(0);
  });

  it('normalizes the email before lookup', async () => {
    repo.user = makeUser(null);

    await useCase.execute('  User@Example.COM  ');

    expect(repo.lastFindEmail).toBe('user@example.com');
  });
});
