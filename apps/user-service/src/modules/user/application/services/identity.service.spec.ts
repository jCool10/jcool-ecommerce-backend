import { bucketForEmail, encode } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import type { IdGeneratorPort } from '../ports';
import { IdentityService } from './identity.service';

const KEY = 'k'.repeat(32);

function recordingGenerator(): IdGeneratorPort & { buckets: number[] } {
  const buckets: number[] = [];
  return {
    buckets,
    mint: (bucket: number, count = 1) => {
      buckets.push(bucket);
      return Promise.resolve(Array.from({ length: count }, (_, i) => `id-${bucket}-${i}`));
    },
  };
}

describe('IdentityService', () => {
  it('refuses a bucket key too short to be one', () => {
    expect(() => new IdentityService(recordingGenerator(), 'short')).toThrow(RangeError);
  });

  it("mints a user id in the bucket the user's email hashes to", async () => {
    const ids = recordingGenerator();
    const email = normalizeEmail('Someone@Example.com');

    await expect(new IdentityService(ids, KEY).mintUserId(email)).resolves.toBe(`id-${bucketForEmail(email, KEY)}-0`);
    expect(ids.buckets).toEqual([bucketForEmail(email, KEY)]);
  });

  it("mints an owned row's id in its owner's bucket", async () => {
    const ids = recordingGenerator();
    const owner = encode({ tsMs: 1, bucket: 77, nodeId: 1, sequence: 0, random: 0 });

    await expect(new IdentityService(ids, KEY).mintOwnedBy(owner)).resolves.toBe('id-77-0');
  });

  it('rejects an owner id that carries no bucket, without asking for an id', async () => {
    const ids = recordingGenerator();

    await expect(new IdentityService(ids, KEY).mintOwnedBy('0190a0b0-0000-7000-8000-000000000000')).rejects.toThrow();
    expect(ids.buckets).toEqual([]);
  });
});
