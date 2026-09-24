import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { sha256Hex } from '..';
import { PlainPasswordHasher } from '../../testing/plain-password-hasher.double';
import { RecordingAuthAudit } from '../../testing/recording-auth-audit.double';
import { RecordingMailer } from '../../testing/recording-mailer.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeSessionEpoch } from '../../testing/session-epoch.double';
import { FakeSingleUseTokenRepository } from '../../testing/single-use-token-repository.double';
import { FakeUserRepository } from '../../testing/user-repository.double';
import { PasswordResetService } from './password-reset.service';
import { SessionService } from './session.service';

const NOW = new Date('2026-09-24T08:00:00.000Z');
const TTL_MS = 60 * 60 * 1000;

describe('PasswordResetService', () => {
  useFakeClock(NOW);

  let log: string[];
  let tokens: FakeSingleUseTokenRepository;
  let users: FakeUserRepository;
  let refreshTokens: FakeRefreshTokenRepository;
  let epochs: FakeSessionEpoch;
  let mailer: RecordingMailer;
  let audit: RecordingAuthAudit;
  let service: PasswordResetService;

  beforeEach(() => {
    log = [];
    tokens = new FakeSingleUseTokenRepository();
    users = new FakeUserRepository(log);
    refreshTokens = new FakeRefreshTokenRepository(log);
    epochs = new FakeSessionEpoch(log);
    mailer = new RecordingMailer();
    audit = new RecordingAuthAudit();
    service = new PasswordResetService(
      tokens,
      users,
      new PlainPasswordHasher(),
      new SessionService(refreshTokens, epochs),
      mailer,
      audit,
      fakeConfigService({ 'auth.passwordResetTtl': '1h' }),
    );
  });

  describe('issueAndSend', () => {
    it('stores only the hash, supersedes older tokens, mails the raw token and audits', async () => {
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      const [emailed] = mailer.resets;
      expect(mailer.resets).toEqual([{ to: 'user@test.local', token: expect.any(String) as string }]);
      expect(tokens.created).toEqual([
        { userId: 'u1', tokenHash: sha256Hex(emailed.token), expiresAt: new Date(NOW.getTime() + TTL_MS) },
      ]);
      expect(tokens.superseded).toEqual([{ userId: 'u1', keptHash: sha256Hex(emailed.token), afterCreates: 1 }]);
      expect(audit.records).toEqual([
        { event: 'password.reset_requested', outcome: 'success', userId: 'u1', email: 'user@test.local' },
      ]);
    });

    // Creating mints an id remotely; a failure there must not cost the user the link they hold.
    it('leaves the live tokens alone when the new one cannot be created', async () => {
      tokens.createError = new Error('id service unavailable');

      await expect(service.issueAndSend({ id: 'u1', email: 'user@test.local' })).rejects.toThrow(
        'id service unavailable',
      );
      expect(tokens.superseded).toHaveLength(0);
      expect(mailer.resets).toHaveLength(0);
    });
  });

  describe('reset', () => {
    // Not one transaction, so revoking first fails safe: a crash leaves the old password with no sessions.
    it('consumes the token, revokes every session, then stores the new hash', async () => {
      tokens.consumeResult = { status: 'consumed', userId: 'u7' };

      await expect(service.reset('raw-token', 'new-password')).resolves.toEqual({ userId: 'u7' });

      expect(tokens.consumedHash).toBe(sha256Hex('raw-token'));
      expect(refreshTokens.revokedAllFor).toEqual(['u7']);
      expect(epochs.epochs.get('u7')).toBe(1);
      expect(users.passwordUpdates).toEqual([{ userId: 'u7', passwordHash: 'hashed:new-password' }]);
      expect(log).toEqual(['revokeAllForUser', 'bump', 'updatePassword']);
    });

    it('answers 400 and changes nothing for a token it cannot consume', async () => {
      tokens.consumeResult = { status: 'invalid' };

      await expect(service.reset('bad', 'new-password')).rejects.toBeInstanceOf(BadRequestException);
      expect(log).toEqual([]);
    });
  });
});
