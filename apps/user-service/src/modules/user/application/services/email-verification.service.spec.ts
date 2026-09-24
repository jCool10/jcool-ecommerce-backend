import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { sha256Hex } from '..';
import { RecordingAuthAudit } from '../../testing/recording-auth-audit.double';
import { RecordingMailer } from '../../testing/recording-mailer.double';
import { FakeSingleUseTokenRepository } from '../../testing/single-use-token-repository.double';
import { FakeUserRepository } from '../../testing/user-repository.double';
import { EmailVerificationService } from './email-verification.service';

const NOW = new Date('2026-09-24T08:00:00.000Z');
const TTL_MS = 24 * 60 * 60 * 1000;

describe('EmailVerificationService', () => {
  useFakeClock(NOW);

  let tokens: FakeSingleUseTokenRepository;
  let users: FakeUserRepository;
  let mailer: RecordingMailer;
  let audit: RecordingAuthAudit;
  let service: EmailVerificationService;

  beforeEach(() => {
    tokens = new FakeSingleUseTokenRepository();
    users = new FakeUserRepository();
    mailer = new RecordingMailer();
    audit = new RecordingAuthAudit();
    service = new EmailVerificationService(
      tokens,
      users,
      mailer,
      audit,
      fakeConfigService({ 'auth.emailVerificationTtl': '24h' }),
    );
  });

  describe('issueAndSend', () => {
    it('stores only the hash, supersedes older tokens, mails the raw token and audits', async () => {
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      const [emailed] = mailer.verifications;
      expect(mailer.verifications).toEqual([{ to: 'user@test.local', token: expect.any(String) as string }]);
      expect(tokens.created).toEqual([
        { userId: 'u1', tokenHash: sha256Hex(emailed.token), expiresAt: new Date(NOW.getTime() + TTL_MS) },
      ]);
      expect(tokens.superseded).toEqual([{ userId: 'u1', keptHash: sha256Hex(emailed.token), afterCreates: 1 }]);
      expect(audit.records).toEqual([
        { event: 'email.verification_sent', outcome: 'success', userId: 'u1', email: 'user@test.local' },
      ]);
    });

    // Creating mints an id remotely; a failure there must not cost the user the link they hold.
    it('leaves the live tokens alone when the new one cannot be created', async () => {
      tokens.createError = new Error('id service unavailable');

      await expect(service.issueAndSend({ id: 'u1', email: 'user@test.local' })).rejects.toThrow(
        'id service unavailable',
      );
      expect(tokens.superseded).toHaveLength(0);
      expect(mailer.verifications).toHaveLength(0);
    });
  });

  describe('verify', () => {
    it('answers 400 and verifies nobody for a token it cannot consume', async () => {
      tokens.consumeResult = { status: 'invalid' };

      await expect(service.verify('bad')).rejects.toBeInstanceOf(BadRequestException);
      expect(tokens.consumedHash).toBe(sha256Hex('bad'));
      expect(users.verified).toHaveLength(0);
    });
  });
});
