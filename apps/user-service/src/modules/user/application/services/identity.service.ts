import { MIN_BUCKET_KEY_LENGTH, bucketForEmail, bucketOf } from '@jcool/id-codec';
import type { NormalizedEmail } from '@jcool/kernel';
import type { IdGeneratorPort } from '../ports/id-generator.port';

/**
 * A user's bucket comes from their email, the same normalized bytes the unique index sees. Rows the
 * user owns copy the bucket out of the user's id rather than re-deriving it. Framework-free, so the
 * seed scripts construct it without booting Nest.
 */
export class IdentityService {
  constructor(
    private readonly ids: IdGeneratorPort,
    private readonly bucketKey: string,
  ) {
    // Checked here too: the seed scripts never pass through env validation.
    if (bucketKey.length < MIN_BUCKET_KEY_LENGTH) {
      throw new RangeError(`Identity bucket key must be at least ${MIN_BUCKET_KEY_LENGTH} characters`);
    }
  }

  async mintUserId(email: NormalizedEmail): Promise<string> {
    return this.mintOne(bucketForEmail(email, this.bucketKey));
  }

  /** Rejects a `userId` from outside this layout: it carries no bucket to colocate with. */
  async mintOwnedBy(userId: string): Promise<string> {
    return this.mintOne(bucketOf(userId));
  }

  private async mintOne(bucket: number): Promise<string> {
    const [id] = await this.ids.mint(bucket, 1);
    return id;
  }
}
