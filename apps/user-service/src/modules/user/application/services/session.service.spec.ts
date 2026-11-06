import { beforeEach, describe, expect, it } from 'vitest';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeSessionEpochPublisher } from '../../testing/session-epoch.double';
import { SessionEpochNotPublishedError } from '../ports';
import { SessionService } from './session.service';

describe('SessionService', () => {
  let log: string[];
  let refreshTokens: FakeRefreshTokenRepository;
  let publisher: FakeSessionEpochPublisher;
  let service: SessionService;

  beforeEach(() => {
    log = [];
    refreshTokens = new FakeRefreshTokenRepository(log);
    publisher = new FakeSessionEpochPublisher(log);
    service = new SessionService(refreshTokens, publisher);
  });

  describe('revokeAll', () => {
    it('revokes every session in one repository write, then publishes the epoch it committed', async () => {
      refreshTokens.revokeAllEpoch = 4;

      await service.revokeAll('u1');

      expect(refreshTokens.revokedAll).toEqual([{ userId: 'u1' }]);
      expect(publisher.published.get('u1')).toBe(4);
      expect(log).toEqual(['revokeAllForUser', 'publish']);
    });

    it('publishes nothing for a missing user', async () => {
      refreshTokens.revokeAllEpoch = null;

      await service.revokeAll('gone');

      expect(log).toEqual(['revokeAllForUser']);
    });
  });

  describe('replacePassword', () => {
    const replacement = { newPasswordHash: 'hashed:new-password', verifiedPasswordHash: 'hashed:old-pw' };

    it('stores the new hash in the write that revokes every session, then publishes', async () => {
      refreshTokens.revokeAllEpoch = 2;

      await expect(service.replacePassword('u1', replacement)).resolves.toBe(true);

      expect(refreshTokens.revokedAll).toEqual([{ userId: 'u1', ...replacement }]);
      expect(publisher.published.get('u1')).toBe(2);
      expect(log).toEqual(['revokeAllForUser', 'publish']);
    });

    // The change is committed by then; only the publish is left for the reconciler.
    it('surfaces a failed publish after the write as SessionEpochNotPublishedError', async () => {
      refreshTokens.revokeAllEpoch = 3;
      publisher.failFor.add('u1');

      const failure = service.replacePassword('u1', replacement);

      await expect(failure).rejects.toBeInstanceOf(SessionEpochNotPublishedError);
      await expect(failure).rejects.toMatchObject({ userId: 'u1', epoch: 3 });
      expect(log).toEqual(['revokeAllForUser', 'publish']);
    });

    it('reports nothing written and publishes nothing when the repository wrote nothing', async () => {
      refreshTokens.revokeAllEpoch = null;

      await expect(service.replacePassword('u1', replacement)).resolves.toBe(false);

      expect(log).toEqual(['revokeAllForUser']);
    });
  });
});
