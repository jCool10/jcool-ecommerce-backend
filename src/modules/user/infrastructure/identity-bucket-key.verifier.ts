import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import { bucketForEmail, bucketOf, identityKeyFingerprint } from '@shared/identity';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { normalizeEmail } from '@shared/kernel';
import { identityKeyPin, users } from './schema/user.schema';

const PIN_ROW_ID = 1;

/**
 * How long either check waits on the database before giving up on it. A pool that cannot connect
 * rejects on its own, but one whose server accepts and then stops answering would otherwise hang
 * `onApplicationBootstrap` forever — turning a check that is meant to fail open into the hard boot
 * dependency the app does not otherwise have.
 */
const DB_CHECK_TIMEOUT_MS = 5_000;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses to boot when the running `IDENTITY_BUCKET_KEY` is not the one this database was built
 * with. A wrong key mints ids into buckets their emails do not hash to, and since nothing reads a
 * bucket until a shard split, the damage would surface years after the key that caused it was lost.
 *
 * Two checks, in order of what they can prove:
 *
 * - The **row canary** compares one real id against the bucket its email hashes to now. It cannot
 *   see a key that was wrong from the very first row — both sides of that comparison use the current
 *   key, so they agree by construction — which is why it is the secondary check, not the primary.
 * - The **pin** compares the key against a fingerprint stored in the database itself, so it holds
 *   with zero rows and survives a restore into an environment carrying a different key.
 *
 * The canary runs first even though the pin is the stronger check, because the pin *writes*: on a
 * database that has rows but no pin row yet, pinning first would record the running key as correct
 * a moment before the canary could prove it is not, and the recorded fingerprint is what every later
 * boot is held to. Corroborate against real data first, then record.
 *
 * Both fail **open** when the database cannot be reached: the app already cannot serve without it,
 * no id is minted while it is down, and the next clean boot re-checks. They fail **closed** only on
 * a disagreement actually read back — that is evidence, not a symptom of an outage.
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
      // through to the comparison below and is held to the winner's fingerprint.
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
      // Newest rather than oldest: an old row only proves the key was right at some point, while the
      // most recent one is what a writer that has started misfiling would have produced. Ordered by
      // id, not `createdAt`: the id leads with a big-endian millisecond timestamp and Postgres
      // compares uuids bytewise, so this walks the primary key instead of sorting the whole table —
      // and it reads mint time rather than transaction-start time.
      [sample] = await this.withinTimeout(
        this.db.select({ id: users.id, email: users.email }).from(users).orderBy(desc(users.id)).limit(1),
      );
    } catch (error) {
      this.logger.warn(`Identity routing canary not checked: ${reason(error)}`);
      return;
    }

    if (!sample) return;

    // Outside the catch above by design: from here on, every failure is a disagreement read back
    // from a reachable database, and must refuse the boot rather than be logged and stepped over.
    const expected = bucketForEmail(normalizeEmail(sample.email), key);
    let actual: number | null = null;
    try {
      actual = bucketOf(sample.id);
    } catch {
      // A non-v8 id carries no bucket at all. Reported below as a mismatch, because the codec's
      // parse error reads like a bug in the codec when the real fault is the row.
    }

    if (actual !== expected) {
      // Named by id, never by email: this message reaches the log pipeline and the error tracker.
      throw new Error(
        `User ${sample.id} does not route to the bucket its email hashes to under the current ` +
          `IDENTITY_BUCKET_KEY (expected ${expected}, id carries ${actual ?? 'no routing bucket'}). ` +
          `Run \`npm run identity:verify\` to size the damage before restarting.`,
      );
    }
  }
}
