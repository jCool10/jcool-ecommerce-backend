import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import { bucketForEmail, bucketOf, identityKeyFingerprint } from '@shared/identity';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { normalizeEmail } from '@shared/kernel';
import { identityKeyPin, users } from './schema/user.schema';

const PIN_ROW_ID = 1;

// A pool that cannot connect rejects on its own; a server that accepts and then goes quiet would
// hang `onApplicationBootstrap` forever, turning a fail-open check into a hard boot dependency.
const DB_CHECK_TIMEOUT_MS = 5_000;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses to boot when the running `IDENTITY_BUCKET_KEY` is not the one this database was built
 * with: a wrong key mints ids into buckets their emails do not hash to, and nothing reads a bucket
 * until a shard split, so the damage surfaces years later. The canary runs before the pin even
 * though the pin is stronger, because the pin *writes* — pinning first on a database that already
 * holds rows would record a wrong key as the reference every later boot is held to. Both fail open
 * on an unreachable database, and fail closed only on a disagreement actually read back.
 */
@Injectable()
export class IdentityBucketKeyVerifier implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdentityBucketKeyVerifier.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const key = this.config.getOrThrow<string>('identity.bucketKey');
    await this.verifyNewestUserRow(key);
    await this.verifyKeyPin(key);
  }

  private async withinTimeout<T>(query: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        query,
        new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(
            () => rejectTimeout(new Error(`no answer in ${DB_CHECK_TIMEOUT_MS}ms`)),
            DB_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyKeyPin(key: string): Promise<void> {
    const fingerprint = identityKeyFingerprint(key);
    let pinned: string | undefined;

    try {
      // Concurrent first boots race here rather than in a read-then-write gap; the loser falls
      // through to the comparison below.
      const [persisted] = await this.withinTimeout(
        this.db
          .insert(identityKeyPin)
          .values({ id: PIN_ROW_ID, fingerprint })
          .onConflictDoNothing()
          .returning({ fingerprint: identityKeyPin.fingerprint }),
      );
      if (persisted) {
        this.logger.log(`Pinned identity bucket key ${fingerprint} — no key was pinned here before`);
        return;
      }

      const [row] = await this.withinTimeout(
        this.db
          .select({ fingerprint: identityKeyPin.fingerprint })
          .from(identityKeyPin)
          .where(eq(identityKeyPin.id, PIN_ROW_ID)),
      );
      pinned = row?.fingerprint;
    } catch (error) {
      this.logger.warn(`Identity bucket key pin not verified: ${reason(error)}`);
      return;
    }

    if (pinned === undefined) {
      this.logger.warn('Identity bucket key pin disappeared while being read; not verified');
      return;
    }
    if (pinned !== fingerprint) {
      throw new Error(
        `IDENTITY_BUCKET_KEY does not match the key this database was built with ` +
          `(pinned ${pinned}, current ${fingerprint}). The key is permanent: booting under a ` +
          `different one routes every new id to a shard that will not hold its rows. Restore the ` +
          `original key, or reset the database if it holds nothing worth keeping.`,
      );
    }
  }

  private async verifyNewestUserRow(key: string): Promise<void> {
    let sample: { id: string; email: string } | undefined;

    try {
      // Newest row: an old one only proves the key was right at some point. Ordered by id, not
      // `createdAt` — the id leads with a big-endian ms timestamp and Postgres compares uuids
      // bytewise, so this walks the primary key instead of sorting the table.
      [sample] = await this.withinTimeout(
        this.db.select({ id: users.id, email: users.email }).from(users).orderBy(desc(users.id)).limit(1),
      );
    } catch (error) {
      this.logger.warn(`Identity routing canary not checked: ${reason(error)}`);
      return;
    }

    if (!sample) return;

    // Outside the catch above: from here on every failure is a disagreement read back from a
    // reachable database, and must refuse the boot rather than be logged and stepped over.
    const expected = bucketForEmail(normalizeEmail(sample.email), key);
    let actual: number | null = null;
    try {
      actual = bucketOf(sample.id);
    } catch {
      // A non-v8 id carries no bucket. Reported below as a mismatch, because the codec's parse error
      // reads like a bug in the codec when the fault is the row.
    }

    if (actual !== expected) {
      // Named by id, never by email: this reaches the log pipeline and the error tracker.
      throw new Error(
        `User ${sample.id} does not route to the bucket its email hashes to under the current ` +
          `IDENTITY_BUCKET_KEY (expected ${expected}, id carries ${actual ?? 'no routing bucket'}). ` +
          `Run \`npm run identity:verify\` to size the damage before restarting.`,
      );
    }
  }
}
