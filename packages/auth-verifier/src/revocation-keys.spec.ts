import { SESSION_EPOCH_KEY_PREFIX, TOKEN_DENYLIST_KEY_PREFIX } from './revocation-keys';

// Renaming one is a migration, not a refactor: a writer and a reader on different releases would
// stop seeing each other's revocations.
describe('revocation keys', () => {
  it('keeps the names the issuer and every verifier share', () => {
    expect(SESSION_EPOCH_KEY_PREFIX).toBe('auth:epoch:');
    expect(TOKEN_DENYLIST_KEY_PREFIX).toBe('auth:denylist:');
  });
});
