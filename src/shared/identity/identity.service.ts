import type { NormalizedEmail } from '@shared/kernel';
import { MIN_BUCKET_KEY_LENGTH, bucketForEmail } from './email-bucket';
import { bucketOf } from './uuid-v8.codec';
import type { UuidV8Generator } from './uuid-v8.generator';

/**
 * A user's bucket comes from their email — the same normalized bytes the unique index sees, which is
 * what makes local email uniqueness survive a shard split. Rows the user owns copy the bucket out of
 * the user's id instead of re-deriving it: a second derivation is a second chance to drift.
 * Framework-free, so the standalone seed scripts can construct it without booting Nest.
 */
export class IdentityService {
  constructor(
    private readonly generator: UuidV8Generator,
    private readonly bucketKey: string,
  ) {
    // Not left to env validation: the seed scripts never pass through it, and a script seeding under
    // a key the app would refuse writes buckets the app can never reproduce.
    if (bucketKey.length < MIN_BUCKET_KEY_LENGTH) {
      throw new RangeError(`Identity bucket key must be at least ${MIN_BUCKET_KEY_LENGTH} characters`);
    }
  }

  mintUserId(email: NormalizedEmail): string {
    return this.generator.generate(bucketForEmail(email, this.bucketKey));
  }

  /** Throws on a non-v8 `userId`: it predates routing and has no bucket to colocate with. */
  mintOwnedBy(userId: string): string {
    return this.generator.generate(bucketOf(userId));
  }
}
