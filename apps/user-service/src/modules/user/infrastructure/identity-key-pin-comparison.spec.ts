import { describe, expect, it } from 'vitest';
import { LAYOUT_VERSION } from '@jcool/id-codec';
import { identityPinMismatch, runningIdentityPin } from './identity-key-pin-comparison';

const KEY = 'pin-comparison-spec-identity-bucket-key-not-a-secret';
const OTHER_KEY = 'another-pin-comparison-spec-key-not-a-real-secret';

describe('identity pin comparison', () => {
  it('names both fingerprints when the key differs', () => {
    const pinned = runningIdentityPin(OTHER_KEY);
    const running = runningIdentityPin(KEY);

    const mismatch = identityPinMismatch(pinned, running);

    expect(mismatch).toMatch(/^IDENTITY_BUCKET_KEY does not match the key this database was built with/);
    expect(mismatch).toContain(`pinned ${pinned.fingerprint}, current ${running.fingerprint}`);
  });

  it('names both layout versions when only the layout differs', () => {
    const running = runningIdentityPin(KEY);

    const mismatch = identityPinMismatch({ ...running, layoutVersion: LAYOUT_VERSION + 1 }, running);

    expect(mismatch).toMatch(/^The id layout does not match the one this database was built with/);
    expect(mismatch).toContain(`pinned ${LAYOUT_VERSION + 1}, current ${LAYOUT_VERSION}`);
  });

  it('reports the key first when both differ', () => {
    const running = runningIdentityPin(KEY);

    expect(identityPinMismatch({ ...runningIdentityPin(OTHER_KEY), layoutVersion: 0 }, running)).toMatch(
      /^IDENTITY_BUCKET_KEY does not match/,
    );
  });
});
