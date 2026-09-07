import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AuthAuditPort,
  AuthAuditRecord,
  ConsumeEmailVerificationOutcome,
  CreateEmailVerificationTokenInput,
  EmailVerificationMessage,
  EmailVerificationTokenRepositoryPort,
  MailerPort,
  PasswordResetMessage,
  UserRepositoryPort,
} from '../ports';
import { sha256Hex } from '..';
import { EmailVerificationService } from './email-verification.service';

const TTL = '24h';
const TTL_MS = 24 * 60 * 60 * 1000;

class MockTokenRepo implements EmailVerificationTokenRepositoryPort {
  created: CreateEmailVerificationTokenInput[] = [];

  // Retention is not this service's concern; SweepAuthTokensService owns and tests it.
  deleteSpentBefore(): Promise<number> {
    return Promise.resolve(0);
  }

  invalidatedFor: string[] = [];
  consumeResult: ConsumeEmailVerificationOutcome = { status: 'invalid' };
  consumedHash?: string;

  create(input: CreateEmailVerificationTokenInput): Promise<void> {
    this.created.push(input);
    return Promise.resolve();
  }
  consume(tokenHash: string): Promise<ConsumeEmailVerificationOutcome> {
    this.consumedHash = tokenHash;
    return Promise.resolve(this.consumeResult);
  }
  invalidateAllForUser(userId: string): Promise<void> {
    this.invalidatedFor.push(userId);
    return Promise.resolve();
  }
}

class MockUserRepo implements Partial<UserRepositoryPort> {
  verified: string[] = [];
  markEmailVerified(userId: string): Promise<void> {
    this.verified.push(userId);
    return Promise.resolve();
  }
}

class MockMailer implements MailerPort {
  sent: EmailVerificationMessage[] = [];
  sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  sendPasswordReset(_message: PasswordResetMessage): Promise<void> {
    return Promise.resolve();
  }
}

class MockAudit implements AuthAuditPort {
  records: AuthAuditRecord[] = [];
  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}

const config = { getOrThrow: () => TTL } as unknown as ConfigService;

describe('EmailVerificationService', () => {
  let tokens: MockTokenRepo;
  let users: MockUserRepo;
  let mailer: MockMailer;
  let audit: MockAudit;
  let service: EmailVerificationService;

  beforeEach(() => {
    tokens = new MockTokenRepo();
    users = new MockUserRepo();
    mailer = new MockMailer();
    audit = new MockAudit();
    service = new EmailVerificationService(tokens, users as unknown as UserRepositoryPort, mailer, audit, config);
  });

  describe('issueAndSend', () => {
    it('invalidates prior tokens, persists only the hash, emails the raw token, and audits', async () => {
      const before = Date.now();
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      expect(tokens.invalidatedFor).toEqual(['u1']); // prior tokens superseded
      expect(tokens.created).toHaveLength(1);
      expect(mailer.sent).toHaveLength(1);

      const emailed = mailer.sent[0];
      expect(emailed.to).toBe('user@test.local');
      // The stored value is the SHA-256 of the emailed raw token — raw never persisted.
      expect(tokens.created[0].tokenHash).toBe(sha256Hex(emailed.token));
      expect(tokens.created[0].userId).toBe('u1');

      // Expiry ≈ now + TTL.
      const expiresAt = tokens.created[0].expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL_MS);

      expect(audit.records).toEqual([
        { event: 'email.verification_sent', outcome: 'success', userId: 'u1', email: 'user@test.local' },
      ]);
    });

    it('invalidates before creating (a resend supersedes the old token)', async () => {
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      expect(tokens.invalidatedFor).toEqual(['u1', 'u1']);
      // Two distinct raw tokens minted across the two sends.
      expect(mailer.sent[0].token).not.toBe(mailer.sent[1].token);
    });
  });

  describe('verify', () => {
    it('consumes a live token and marks the owner verified', async () => {
      tokens.consumeResult = { status: 'consumed', userId: 'u7' };

      const result = await service.verify('raw-token');

      expect(tokens.consumedHash).toBe(sha256Hex('raw-token')); // looked up by hash
      expect(users.verified).toEqual(['u7']);
      expect(result).toEqual({ userId: 'u7' });
    });

    it('throws 400 and marks nobody verified on an invalid/expired/used token', async () => {
      tokens.consumeResult = { status: 'invalid' };

      await expect(service.verify('bad')).rejects.toBeInstanceOf(BadRequestException);
      expect(users.verified).toHaveLength(0);
    });
  });
});
