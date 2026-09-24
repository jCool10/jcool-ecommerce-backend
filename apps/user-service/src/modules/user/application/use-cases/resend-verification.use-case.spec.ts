import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { User } from '../../domain/entities/user.entity';
import { FakeUserRepository } from '../../testing/user-repository.double';
import type { EmailVerificationService, VerificationRecipient } from '../services';
import { ResendVerificationUseCase } from './resend-verification.use-case';

function makeUser(emailVerifiedAt: Date | null): User {
  return new User('u1', 'user@example.com', 'hash', 'CUSTOMER', new Date(), new Date(), emailVerifiedAt);
}

class StubEmailVerification {
  sentTo: VerificationRecipient[] = [];
  outcome: () => Promise<void> = () => Promise.resolve();
  issueAndSend(recipient: VerificationRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return this.outcome();
  }
}

describe('ResendVerificationUseCase', () => {
  let users: FakeUserRepository;
  let emailVerification: StubEmailVerification;
  let warn: Mock;
  let useCase: ResendVerificationUseCase;

  beforeEach(() => {
    users = new FakeUserRepository();
    users.user = makeUser(null);
    emailVerification = new StubEmailVerification();
    warn = vi.fn();
    useCase = new ResendVerificationUseCase(
      users,
      emailVerification as unknown as EmailVerificationService,
      fakePinoLogger({ warn }),
    );
  });

  it('issues a fresh token to the unverified account behind the normalized address', async () => {
    await useCase.execute('  User@Example.COM  ');

    expect(users.lastFindEmail).toBe('user@example.com');
    expect(emailVerification.sentTo).toEqual([users.user]);
  });

  it('sends nothing to an account that is already verified', async () => {
    users.user = makeUser(new Date());

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
    expect(emailVerification.sentTo).toHaveLength(0);
  });

  // Issuing mints an id remotely; waiting on it would make a known address slower than an unknown one.
  it('answers without waiting for the token to be issued', async () => {
    emailVerification.outcome = () => new Promise(() => undefined);

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
  });

  it('logs a failed issuance and still answers the same', async () => {
    emailVerification.outcome = () => Promise.reject(new Error('id service unavailable'));

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), expect.any(String)),
    );
  });
});
