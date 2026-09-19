import { describe, expect, it } from 'vitest';
import { canonicalJson, computeRequestHash, sha256Hex } from './request-hash.util';

describe('canonicalJson', () => {
  it('is stable across field order (same content → same string)', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested object keys, not just the top level', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(canonicalJson({ outer: { a: 2, z: 1 } }));
  });

  it('preserves array order (arrays are positional, not sorted)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes different content', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('sha256Hex', () => {
  it('returns a 64-char lowercase hex digest', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
  });
});

describe('computeRequestHash', () => {
  const scope = 'user:u1';

  it('is field-order independent for the body', () => {
    expect(computeRequestHash('POST', '/orders', scope, { b: 1, a: 2 })).toBe(
      computeRequestHash('POST', '/orders', scope, { a: 2, b: 1 }),
    );
  });

  it('changes when the body content changes (drives the 422 mismatch branch)', () => {
    expect(computeRequestHash('POST', '/orders', scope, { qty: 1 })).not.toBe(
      computeRequestHash('POST', '/orders', scope, { qty: 2 }),
    );
  });

  it('changes with scope so one user cannot match another user’s record', () => {
    expect(computeRequestHash('POST', '/orders', 'user:a', {})).not.toBe(
      computeRequestHash('POST', '/orders', 'user:b', {}),
    );
  });

  it('treats a missing body as null (no throw)', () => {
    expect(computeRequestHash('POST', '/orders', scope, undefined)).toBe(
      computeRequestHash('POST', '/orders', scope, null),
    );
  });
});
