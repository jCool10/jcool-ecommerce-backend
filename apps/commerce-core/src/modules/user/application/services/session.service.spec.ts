import { beforeEach, describe, expect, it } from 'vitest';
import { hashRefreshToken } from '..';
import type { ActiveSession, RefreshTokenRepositoryPort, SessionEpochPort } from '../ports';
import { SessionService } from './session.service';

const SESSIONS: ActiveSession[] = [
  {
    id: 'fam-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    current: true,
  },
];

class MockRefreshRepo implements Partial<RefreshTokenRepositoryPort> {
  listArgs?: { userId: string; currentTokenHash: string | null };
  revokeFamilyArgs?: { userId: string; familyId: string };
  revokedAllFor: string[] = [];
  revokeFamilyResult = true;

  listActiveSessions(userId: string, currentTokenHash: string | null): Promise<ActiveSession[]> {
    this.listArgs = { userId, currentTokenHash };
    return Promise.resolve(SESSIONS);
  }
  revokeFamily(userId: string, familyId: string): Promise<boolean> {
    this.revokeFamilyArgs = { userId, familyId };
    return Promise.resolve(this.revokeFamilyResult);
  }
  revokeAllForUser(userId: string): Promise<void> {
    this.revokedAllFor.push(userId);
    return Promise.resolve();
  }
}

class MockSessionEpoch implements SessionEpochPort {
  bumpedFor: string[] = [];
  current(): Promise<number | null> {
    return Promise.resolve(0);
  }
  bump(userId: string): Promise<number> {
    this.bumpedFor.push(userId);
    return Promise.resolve(this.bumpedFor.length);
  }
}

describe('SessionService', () => {
  let repo: MockRefreshRepo;
  let epoch: MockSessionEpoch;
  let service: SessionService;

  beforeEach(() => {
    repo = new MockRefreshRepo();
    epoch = new MockSessionEpoch();
    service = new SessionService(repo as unknown as RefreshTokenRepositoryPort, epoch);
  });

  describe('listActiveSessions', () => {
    it('hashes the presented refresh token before querying (never passes the raw value)', async () => {
      const result = await service.listActiveSessions('u1', 'raw-refresh-token');

      expect(repo.listArgs).toEqual({ userId: 'u1', currentTokenHash: hashRefreshToken('raw-refresh-token') });
      expect(repo.listArgs?.currentTokenHash).not.toBe('raw-refresh-token');
      expect(result).toBe(SESSIONS);
    });

    it('passes a null hash when there is no current session cookie', async () => {
      await service.listActiveSessions('u1', null);
      expect(repo.listArgs).toEqual({ userId: 'u1', currentTokenHash: null });
    });
  });

  describe('revokeSession', () => {
    it('delegates to revokeFamily and returns its result', async () => {
      repo.revokeFamilyResult = false;
      const revoked = await service.revokeSession('u1', 'fam-9');

      expect(repo.revokeFamilyArgs).toEqual({ userId: 'u1', familyId: 'fam-9' });
      expect(revoked).toBe(false);
    });
  });

  describe('revokeAll', () => {
    it('revokes every refresh token and bumps the session epoch (global kill)', async () => {
      await service.revokeAll('u1');

      expect(repo.revokedAllFor).toEqual(['u1']);
      expect(epoch.bumpedFor).toEqual(['u1']);
    });
  });
});
