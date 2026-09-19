import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { User } from '../../domain/entities/user.entity';
import type { UserRepositoryPort } from '../ports';
import { EmailLookupUserRepository } from '../../testing/user-repository.double';
import type { PasswordResetService, ResetRecipient } from '../services';
import { ForgotPasswordUseCase } from './forgot-password.use-case';

function makeUser(emailVerifiedAt: Date | null = null): User {
  return new User('u1', 'user@example.com', 'hash', 'CUSTOMER', new Date(), new Date(), emailVerifiedAt);
}

class MockPasswordReset {
  sentTo: ResetRecipient[] = [];
  outcome: () => Promise<void> = () => Promise.resolve();
  issueAndSend(recipient: ResetRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return this.outcome();
  }
}

describe('ForgotPasswordUseCase', () => {
  let repo: EmailLookupUserRepository;
  let passwordReset: MockPasswordReset;
  let warn: Mock;
  let useCase: ForgotPasswordUseCase;

  beforeEach(() => {
    repo = new EmailLookupUserRepository();
    passwordReset = new MockPasswordReset();
    warn = vi.fn();
    useCase = new ForgotPasswordUseCase(
      repo as unknown as UserRepositoryPort,
      passwordReset as unknown as PasswordResetService,
      fakePinoLogger({ warn }),
    );
  });

  // Issuing mints an id remotely; waiting on it would make a known address slower than an unknown one.
  it('answers without waiting for the token to be issued', async () => {
    repo.user = makeUser();
    passwordReset.outcome = () => new Promise(() => undefined);

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
  });

  it('logs a failed issuance rather than answering differently', async () => {
    repo.user = makeUser();
    passwordReset.outcome = () => Promise.reject(new Error('id service unavailable'));

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), expect.any(String)),
    );
  });

  it('issues a reset token for an existing account', async () => {
    repo.user = makeUser();

    await useCase.execute('user@example.com');

    expect(passwordReset.sentTo).toEqual([repo.user]);
  });

  it('issues a reset token even for an unverified account (reset is independent of verification)', async () => {
    repo.user = makeUser(null);

    await useCase.execute('user@example.com');

    expect(passwordReset.sentTo).toEqual([repo.user]);
  });

  it('is a silent no-op for an unknown address (no enumeration)', async () => {
    repo.user = null;

    await expect(useCase.execute('nobody@example.com')).resolves.toBeUndefined();
    expect(passwordReset.sentTo).toHaveLength(0);
  });

  it('normalizes the email before lookup', async () => {
    repo.user = makeUser();

    await useCase.execute('  User@Example.COM  ');

    expect(repo.lastFindEmail).toBe('user@example.com');
  });
});
