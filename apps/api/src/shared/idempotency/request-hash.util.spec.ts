import { describe, expect, it } from 'vitest';
import { canonicalJson, computeRequestHash } from './request-hash.util';

describe('request hash', () => {
  // A retry that reorders fields must not read as a key/body mismatch.
  it('sorts object keys at every depth and leaves arrays in order', () => {
    expect(canonicalJson({ z: 1, outer: { y: [2, 1], a: { d: 1, c: 2 } } })).toBe(
      '{"outer":{"a":{"c":2,"d":1},"y":[2,1]},"z":1}',
    );
  });

  it("changes with scope so one user cannot match another user's record", () => {
    expect(computeRequestHash('POST', '/orders', 'user:a', {})).not.toBe(
      computeRequestHash('POST', '/orders', 'user:b', {}),
    );
  });

  it('treats a missing body as null', () => {
    expect(computeRequestHash('POST', '/orders', 'user:u1', undefined)).toBe(
      computeRequestHash('POST', '/orders', 'user:u1', null),
    );
  });
});
