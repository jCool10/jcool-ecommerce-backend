import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '@shared/kernel';
import { MIN_BUCKET_KEY_LENGTH, bucketForEmail } from './email-bucket';
import { IdentityService } from './identity.service';
import { UuidV8Generator } from './uuid-v8.generator';
import { bucketOf, decode } from './uuid-v8.codec';

const KEY = 'identity-service-spec-key-not-a-real-secret';
const OTHER_KEY = 'identity-service-spec-other-key-not-a-real-secret';
const NODE_ID = 7;

function service(key: string = KEY): IdentityService {
  return new IdentityService(UuidV8Generator.create({ nodeId: NODE_ID }), key);
}

describe('IdentityService', () => {
  it('routes a user id to the bucket their email hashes to', () => {
    const email = normalizeEmail('Alice@Example.COM');

    expect(bucketOf(service().mintUserId(email))).toBe(bucketForEmail(email, KEY));
  });

  // A service that ignored its injected key and reached for a constant passes one of these and
  // fails the other. A wrong key produces ids that look valid and route to the wrong shard.
  it('buckets under the key it was given, not a fixed one', () => {
    for (const raw of ['a@example.com', 'b@example.com', 'c@example.com']) {
      const email = normalizeEmail(raw);

      expect(bucketOf(service(KEY).mintUserId(email))).toBe(bucketForEmail(email, KEY));
      expect(bucketOf(service(OTHER_KEY).mintUserId(email))).toBe(bucketForEmail(email, OTHER_KEY));
    }
  });

  it('puts everything a user owns in the user’s own bucket', () => {
    const identity = service();
    const userId = identity.mintUserId(normalizeEmail('owner@example.com'));

    const owned = [identity.mintOwnedBy(userId), identity.mintOwnedBy(userId), identity.mintOwnedBy(userId)];

    expect(owned.map(bucketOf)).toEqual([bucketOf(userId), bucketOf(userId), bucketOf(userId)]);
    expect(new Set(owned).size).toBe(owned.length);
  });

  // Owner and owned rows are inserted by different code paths, so nothing but this refusal stops a
  // token minted against a pre-routing id from landing in whichever bucket its bits happen to spell.
  it('refuses an owner id that carries no bucket of its own', () => {
    expect(() => service().mintOwnedBy(randomUUID())).toThrow(/Not a UUIDv8/);
    expect(() => service().mintOwnedBy('not-a-uuid')).toThrow(/Not a canonical UUID/);
  });

  // Env validation covers the app; the seed scripts construct this directly, so the refusal has to
  // live at the constructor to reach both writers.
  it('refuses a key too short to resist an offline search', () => {
    expect(() => service('')).toThrow(RangeError);
    expect(() => service('k'.repeat(MIN_BUCKET_KEY_LENGTH - 1))).toThrow(RangeError);
    expect(() => service('k'.repeat(MIN_BUCKET_KEY_LENGTH))).not.toThrow();
  });

  it('stamps the generator’s node id, not the bucket, into the node field', () => {
    const fields = decode(service().mintUserId(normalizeEmail('node@example.com')));

    expect(fields.nodeId).toBe(NODE_ID);
  });
});
