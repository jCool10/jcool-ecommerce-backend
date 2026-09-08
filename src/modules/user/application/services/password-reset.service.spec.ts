import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AuthAuditPort,
  AuthAuditRecord,
  ConsumePasswordResetOutcome,
  CreatePasswordResetTokenInput,
  EmailVerificationMessage,
  MailerPort,
  PasswordHasherPort,
  PasswordResetMessage,
  PasswordResetTokenRepositoryPort,
  UserRepositoryPort,
} from '../ports';
import { sha256Hex } from '..';
import { PasswordResetService } from './password-reset.service';
import { SessionService } from './session.service';

const TTL = '1h';
const TTL_MS = 60 * 60 * 1000;

class MockTokenRepo implements PasswordResetTokenRepositoryPort {
  created: CreatePasswordResetTokenInput[] = [];

  // Retention is not this service's concern; SweepAuthTokensService owns and tests it.
  deleteSpentBefore(): Promise<number> {
    return Promise.resolve(0);
  }

  invalidatedFor: string[] = [];
  consumeResult: ConsumePasswordResetOutcome = { status: 'invalid' };
  consumedHash?: string;

  create(input: CreatePasswordResetTokenInput): Promise<void> {
    this.created.push(input);
    return Promise.resolve();
  }
  consume(tokenHash: string): Promise<ConsumePasswordResetOutcome> {
    this.consumedHash = tokenHash;
    return Promise.resolve(this.consumeResult);
  }
  invalidateAllForUser(userId: string): Promise<void> {
    this.invalidatedFor.push(userId);
    return Promise.resolve();
  }
}

class MockUserRepo implements Partial<UserRepositoryPort> {
  updated: Array<{ userId: string; passwordHash: string }> = [];
  updatePassword(userId: string, passwordHash: string): Promise<void> {
    this.updated.push({ userId, passwordHash });
    return Promise.resolve();
  }
}

class MockHasher implements PasswordHasherPort {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hashed:${plain}`);
  }
  verify(digest: string, plain: string): Promise<boolean> {
    return Promise.resolve(digest === `hashed:${plain}`);
  }
}

class MockSessions {
  revokedAll: string[] = [];
  revokeAll(userId: string): Promise<void> {
    this.revokedAll.push(userId);
    return Promise.resolve();
  }
}

class MockMailer implements MailerPort {
  reset: PasswordResetMessage[] = [];
  sendEmailVerification(_message: EmailVerificationMessage): Promise<void> {
    return Promise.resolve();
  }
  sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    this.reset.push(message);
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

describe('PasswordResetService', () => {
  let tokens: MockTokenRepo;
  let users: MockUserRepo;
  let hasher: MockHasher;
  let sessions: MockSessions;
  let mailer: MockMailer;
  let audit: MockAudit;
  let service: PasswordResetService;

  beforeEach(() => {
    tokens = new MockTokenRepo();
    users = new MockUserRepo();
    hasher = new MockHasher();
    sessions = new MockSessions();
    mailer = new MockMailer();
    audit = new MockAudit();
    service = new PasswordResetService(
      tokens,
      users as unknown as UserRepositoryPort,
      hasher,
      sessions as unknown as SessionService,
      mailer,
      audit,
      config,
    );
  });

  describe('issueAndSend', () => {
    it('invalidates prior tokens, persists only the hash, emails the raw token, and audits', async () => {
      const before = Date.now();
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      expect(tokens.invalidatedFor).toEqual(['u1']);
      expect(tokens.created).toHaveLength(1);
      expect(mailer.reset).toHaveLength(1);

      const emailed = mailer.reset[0];
      expect(emailed.to).toBe('user@test.local');
      expect(tokens.created[0].tokenHash).toBe(sha256Hex(emailed.token));
      expect(tokens.created[0].userId).toBe('u1');

      const expiresAt = tokens.created[0].expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL_MS);

      expect(audit.records).toEqual([
        { event: 'password.reset_requested', outcome: 'success', userId: 'u1', email: 'user@test.local' },
      ]);
    });

    it('mints a distinct raw token per request', async () => {
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });
      await service.issueAndSend({ id: 'u1', email: 'user@test.local' });

      expect(tokens.invalidatedFor).toEqual(['u1', 'u1']);
      expect(mailer.reset[0].token).not.toBe(mailer.reset[1].token);
    });
  });

  describe('reset', () => {
    it('consumes a live token, sets the new password hash, and revokes all sessions', async () => {
      tokens.consumeResult = { status: 'consumed', userId: 'u7' };

      const result = await service.reset('raw-token', 'new-password');

      expect(tokens.consumedHash).toBe(sha256Hex('raw-token'));
      expect(users.updated).toEqual([{ userId: 'u7', passwordHash: 'hashed:new-password' }]);
      expect(sessions.revokedAll).toEqual(['u7']);
      expect(result).toEqual({ userId: 'u7' });
    });

    it('throws 400 and changes nothing on an invalid/expired/used token', async () => {
      tokens.consumeResult = { status: 'invalid' };

      await expect(service.reset('bad', 'new-password')).rejects.toBeInstanceOf(BadRequestException);
      expect(users.updated).toHaveLength(0);
      expect(sessions.revokedAll).toHaveLength(0);
    });
  });
});
