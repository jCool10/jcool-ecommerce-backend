import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { User } from '../../domain/entities/user.entity';
import { FakeUserRepository } from '../../testing/user-repository.double';
import type { PasswordResetService, ResetRecipient } from '../services';
import { ForgotPasswordUseCase } from './forgot-password.use-case';

class StubPasswordReset {
  sentTo: ResetRecipient[] = [];
  outcome: () => Promise<void> = () => Promise.resolve();
  issueAndSend(recipient: ResetRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return this.outcome();
  }
}

describe('ForgotPasswordUseCase', () => {
  let users: FakeUserRepository;
  let passwordReset: StubPasswordReset;
  let warn: Mock;
  let useCase: ForgotPasswordUseCase;

  beforeEach(() => {
    users = new FakeUserRepository();
    users.user = new User('u1', 'user@example.com', 'hash', 'CUSTOMER', new Date(), new Date());
    passwordReset = new StubPasswordReset();
    warn = vi.fn();
    useCase = new ForgotPasswordUseCase(
      users,
      passwordReset as unknown as PasswordResetService,
      fakePinoLogger({ warn }),
    );
  });

  it('issues a reset token to the account behind the normalized address', async () => {
    await useCase.execute('  User@Example.COM  ');

    expect(users.lastFindEmail).toBe('user@example.com');
    expect(passwordReset.sentTo).toEqual([users.user]);
  });

  // Issuing mints an id remotely; waiting on it would make a known address slower than an unknown one.
  it('answers without waiting for the token to be issued', async () => {
    passwordReset.outcome = () => new Promise(() => undefined);

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
  });

  it('logs a failed issuance and still answers the same', async () => {
    passwordReset.outcome = () => Promise.reject(new Error('id service unavailable'));

    await expect(useCase.execute('user@example.com')).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), expect.any(String)),
    );
  });
});
