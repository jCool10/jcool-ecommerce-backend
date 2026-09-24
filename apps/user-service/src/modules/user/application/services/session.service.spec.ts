import { beforeEach, describe, expect, it } from 'vitest';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeSessionEpoch } from '../../testing/session-epoch.double';
import { SessionEpochNotPublishedError } from '../ports';
import { SessionService } from './session.service';

describe('SessionService.revokeAllThen', () => {
  let log: string[];
  let epochs: FakeSessionEpoch;
  let service: SessionService;

  const write = (): Promise<void> => {
    log.push('write');
    return Promise.resolve();
  };

  beforeEach(() => {
    log = [];
    epochs = new FakeSessionEpoch(log);
    service = new SessionService(new FakeRefreshTokenRepository(log), epochs);
  });

  it('writes only after the refresh tokens are revoked and the epoch is bumped', async () => {
    await service.revokeAllThen('u1', write);

    expect(log).toEqual(['revokeAllForUser', 'bump', 'write']);
  });

  // The bump is committed by then: skipping the write would strand a half-applied change.
  it('still writes when only the publish failed, then surfaces that failure', async () => {
    const unpublished = new SessionEpochNotPublishedError('u1', 1, new Error('redis down'));
    epochs.bumpError = unpublished;

    await expect(service.revokeAllThen('u1', write)).rejects.toBe(unpublished);
    expect(log).toEqual(['revokeAllForUser', 'bump', 'write']);
  });

  it('does not write when the bump itself failed', async () => {
    epochs.bumpError = new Error('db down');

    await expect(service.revokeAllThen('u1', write)).rejects.toThrow('db down');
    expect(log).toEqual(['revokeAllForUser', 'bump']);
  });
});
