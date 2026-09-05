import type { NormalizedEmail } from '@shared/kernel';
import { MIN_BUCKET_KEY_LENGTH, bucketForEmail } from './email-bucket';
import { bucketOf } from './uuid-v8.codec';
import type { UuidV8Generator } from './uuid-v8.generator';

/**
 * Binds the routing-bucket policy to one generator, so every user-context id is minted the same way
 * from one place.
 *
 * A user's bucket comes from their email — the same normalized bytes the unique index sees, which is
 * what makes local email uniqueness survive a shard split. Everything the user owns copies the
 * bucket out of the user's own id instead of re-deriving it: the email is not in scope at those call
 * sites, and a second derivation is a second chance to drift from the first.
 *
 * Framework-free on purpose. The standalone seed scripts are writers too, and they construct this
 * directly rather than booting Nest.
 */
export class IdentityService {
  constructor(
    private readonly generator: UuidV8Generator,
    private readonly bucketKey: string,
  ) {
    // Checked here rather than left to env validation, because the standalone scripts construct this
    // without ever passing through it — and a script that seeds under a key the app would refuse
    // writes rows whose buckets the app can never reproduce.
    if (bucketKey.length < MIN_BUCKET_KEY_LENGTH) {
      throw new RangeError(`Identity bucket key must be at least ${MIN_BUCKET_KEY_LENGTH} characters`);
    }
  }

  mintUserId(email: NormalizedEmail): string {
    return this.generator.generate(bucketForEmail(email, this.bucketKey));
  }

  /** Id for a row owned by `userId`, in that user's bucket. Throws on a non-v8 `userId` — such a row predates the routing bucket, and there is no bucket to colocate with. */
  mintOwnedBy(userId: string): string {
    return this.generator.generate(bucketOf(userId));
  }
}
