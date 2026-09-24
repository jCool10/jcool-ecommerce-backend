import { ConflictException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PlainPasswordHasher } from '../../testing/plain-password-hasher.double';
import { FakeSessionEpochPublisher } from '../../testing/session-epoch.double';
import { FakeUserRepository } from '../../testing/user-repository.double';
import type { EmailVerificationService, VerificationRecipient } from '../services';
import { RegisterUserUseCase } from './register-user.use-case';

class StubEmailVerification {
  sentTo: VerificationRecipient[] = [];
  outcome: () => Promise<void> = () => Promise.resolve();
  issueAndSend(recipient: VerificationRecipient): Promise<void> {
    this.sentTo.push(recipient);
    return this.outcome();
  }
}

describe('RegisterUserUseCase', () => {
  let users: FakeUserRepository;
  let hasher: PlainPasswordHasher;
  let emailVerification: StubEmailVerification;
  let publisher: FakeSessionEpochPublisher;
  let warn: Mock;
  let useCase: RegisterUserUseCase;

  beforeEach(() => {
    users = new FakeUserRepository();
    hasher = new PlainPasswordHasher();
    emailVerification = new StubEmailVerification();
    publisher = new FakeSessionEpochPublisher();
    warn = vi.fn();
    useCase = new RegisterUserUseCase(
      users,
      hasher,
      emailVerification as unknown as EmailVerificationService,
      publisher,
      fakePinoLogger({ warn }),
    );
  });

  it('creates the user under the normalized address with a hashed password', async () => {
    const user = await useCase.execute({ email: '  User@Example.COM  ', password: 'supersecret' });

    expect(users.created).toEqual({ email: 'user@example.com', passwordHash: 'hashed:supersecret' });
    expect(user.id).toBe('new-id');
  });

  it('answers 409 for a taken email and publishes or mails nothing', async () => {
    users.emailTaken = true;

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Hashing before the insert makes a taken address cost what a real signup costs.
    expect(hasher.hashCalls).toBe(1);
    expect(publisher.published.size).toBe(0);
    expect(emailVerification.sentTo).toHaveLength(0);
  });

  it('still registers when the epoch cannot be published', async () => {
    publisher.failFor.add('new-id');

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).resolves.toMatchObject({
      id: 'new-id',
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'new-id' }), expect.any(String));
  });

  it('still returns the created user when the verification mail cannot be issued', async () => {
    emailVerification.outcome = () => Promise.reject(new Error('id service unavailable'));

    await expect(useCase.execute({ email: 'user@example.com', password: 'supersecret' })).resolves.toMatchObject({
      id: 'new-id',
    });
  });
});
