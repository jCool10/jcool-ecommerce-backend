import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { bucketForEmail, bucketOf } from '@jcool/id-codec';
import { normalizeEmail, toError } from '@jcool/kernel';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { type IdentityPin, identityPinMismatch, runningIdentityPin } from './identity-key-pin-comparison';
import { identityKeyPin, users } from './schema/user.schema';

const PIN_ROW_ID = 1;

// A pool that cannot connect rejects on its own; a server that accepts and then goes quiet would
// hang `onApplicationBootstrap` forever, turning a fail-open check into a hard boot dependency.
const DB_CHECK_TIMEOUT_MS = 5_000;

const LOG_CONTEXT = 'IdentityBucketKeyVerifier';

const PIN_NOT_VERIFIED = 'identity bucket key pin not verified';

type PinRead = IdentityPin | 'absent' | 'unreadable';

/**
 * Refuses to boot when the running `IDENTITY_BUCKET_KEY` is not the one this database was built
 * with: a wrong key mints ids into buckets their emails do not hash to, and nothing reads a bucket
 * until a shard split, so the damage surfaces years later. The pin is read and compared before the
 * row canary, because under a changed layout the canary misreads the newest row as a key fault. It
 * is only *written* after the canary passes: pinning on a database that already holds rows would
 * record a wrong key as the reference every later boot is held to. The canary is blind to a key
 * wrong from row 1 — both sides then hash under it and agree — which is what the pin catches. Both
 * fail open on an unreachable database, closed only on a disagreement read back.
 *
 * With `identity.pinBootstrap` off the pin is only compared: this database is filled by copying
 * another one, pin included, and a pin written before that copy would be the empty database's.
 */
@Injectable()
export class IdentityBucketKeyVerifier implements OnApplicationBootstrap {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async onApplicationBootstrap(): Promise<void> {
    const key = this.config.getOrThrow<string>('identity.bucketKey');
    const running = runningIdentityPin(key);

    const pinned = await this.readPin();
    if (typeof pinned === 'object') assertPinMatches(pinned, running);

    const canaryRan = await this.verifyNewestUserRow(key);
    if (pinned !== 'absent') return;

    if (canaryRan) await this.bootstrapPin(running);
    else this.logger.warn('identity bucket key pin not written — the row canary could not run; the next boot retries');
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

  private async readPin(): Promise<PinRead> {
    try {
      const [row] = await this.withinTimeout(
        this.db
          .select({ fingerprint: identityKeyPin.fingerprint, layoutVersion: identityKeyPin.layoutVersion })
          .from(identityKeyPin)
          .where(eq(identityKeyPin.id, PIN_ROW_ID)),
      );
      return row ?? 'absent';
    } catch (error) {
      this.logger.warn({ err: toError(error) }, PIN_NOT_VERIFIED);
      return 'unreadable';
    }
  }

  private async bootstrapPin(running: IdentityPin): Promise<void> {
    if (this.config.get<boolean>('identity.pinBootstrap') !== true) {
      this.logger.warn('no identity bucket key pin here and IDENTITY_PIN_BOOTSTRAP is off — not verified');
      return;
    }

    let persisted: { fingerprint: string } | undefined;
    try {
      // Concurrent first boots race here rather than in a read-then-write gap; the loser re-reads
      // the winner's pin below.
      [persisted] = await this.withinTimeout(
        this.db
          .insert(identityKeyPin)
          .values({ id: PIN_ROW_ID, ...running })
          .onConflictDoNothing()
          .returning({ fingerprint: identityKeyPin.fingerprint }),
      );
    } catch (error) {
      this.logger.warn({ err: toError(error) }, PIN_NOT_VERIFIED);
      return;
    }
    if (persisted) {
      this.logger.info({ ...running }, 'identity bucket key pinned — no key was pinned here before');
      return;
    }

    const pinned = await this.readPin();
    if (pinned === 'absent') this.logger.warn('identity bucket key pin disappeared while being read — not verified');
    if (typeof pinned === 'object') assertPinMatches(pinned, running);
  }

  /** Resolves `false` when the users table could not be read, so nothing was checked. */
  private async verifyNewestUserRow(key: string): Promise<boolean> {
    let sample: { id: string; email: string } | undefined;

    try {
      // Newest row: an old one only proves the key was right at some point. Ordered by id, not
      // `createdAt` — the id carries its millisecond in the high bits of a bigint, so numeric order
      // is time order and this walks the primary key instead of sorting the table.
      [sample] = await this.withinTimeout(
        this.db.select({ id: users.id, email: users.email }).from(users).orderBy(desc(users.id)).limit(1),
      );
    } catch (error) {
      this.logger.warn({ err: toError(error) }, 'identity routing canary not checked');
      return false;
    }

    if (!sample) return true;

    // Outside the catch above: from here on every failure is a disagreement read back from a
    // reachable database, and must refuse the boot rather than be logged and stepped over.
    const expected = bucketForEmail(normalizeEmail(sample.email), key);
    let actual: number | null = null;
    try {
      actual = bucketOf(sample.id);
    } catch {
      // An id from outside this layout carries no bucket we can read. Reported below as a mismatch,
      // because the codec's parse error reads like a bug in the codec when the fault is the row.
    }

    if (actual !== expected) {
      // Named by id, never by email: this reaches the log pipeline and the error tracker.
      throw new Error(
        `User ${sample.id} does not route to the bucket its email hashes to under the current ` +
          `IDENTITY_BUCKET_KEY (expected ${expected}, id carries ${actual ?? 'no routing bucket'}). ` +
          `Run \`pnpm identity:verify\` to size the damage before restarting.`,
      );
    }
    return true;
  }
}

function assertPinMatches(pinned: IdentityPin, running: IdentityPin): void {
  const mismatch = identityPinMismatch(pinned, running);
  if (mismatch !== null) throw new Error(mismatch);
}
