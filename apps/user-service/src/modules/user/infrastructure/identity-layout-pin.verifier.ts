import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { LAYOUT_VERSION } from '@jcool/id-codec';
import { toError } from '@jcool/kernel';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { identityKeyPin, users } from './schema/user.schema';

const PIN_ROW_ID = 1;

// A pool that cannot connect rejects on its own; a server that accepts and then goes quiet would
// hang `onApplicationBootstrap` forever, turning a fail-open check into a hard boot dependency.
const DB_CHECK_TIMEOUT_MS = 5_000;

const LOG_CONTEXT = 'IdentityLayoutPinVerifier';

const PIN_NOT_VERIFIED = 'id layout pin not verified';

type PinRead = { layoutVersion: number } | 'absent' | 'unreadable';

/** Null when a database pinned under `pinned` may be used by this build, otherwise the reason it may not. */
export function identityLayoutMismatch(pinned: number, running: number = LAYOUT_VERSION): string | null {
  if (pinned === running) return null;
  return (
    `The id layout does not match the one this database was built with (pinned ${pinned}, current ` +
    `${running}). The epoch and the field widths are permanent: every stored id decodes into ` +
    `different fields under another layout, and new ids sort below the stored ones. Restore the ` +
    `original build, or reset the database if it holds nothing worth keeping.`
  );
}

/**
 * Refuses to boot when this build's id layout is not the one the database was built with. Fails open
 * on an unreachable database, closed on a disagreement read back or a requested pin it could not write.
 *
 * The pin is only written on a database that holds no users: rows minted before any pin was taken
 * carry a layout this boot cannot read back, and pinning the running one would make a guess the
 * reference every later boot is held to. With `identity.pinBootstrap` off the pin is only compared.
 */
@Injectable()
export class IdentityLayoutPinVerifier implements OnApplicationBootstrap {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async onApplicationBootstrap(): Promise<void> {
    const pinned = await this.readPin();
    if (typeof pinned === 'object') assertLayoutMatches(pinned.layoutVersion);
    else if (pinned === 'absent') await this.bootstrapPin();
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
          .select({ layoutVersion: identityKeyPin.layoutVersion })
          .from(identityKeyPin)
          .where(eq(identityKeyPin.id, PIN_ROW_ID)),
      );
      return row ?? 'absent';
    } catch (error) {
      this.logger.warn({ err: toError(error) }, PIN_NOT_VERIFIED);
      return 'unreadable';
    }
  }

  private async bootstrapPin(): Promise<void> {
    if (this.config.get<boolean>('identity.pinBootstrap') !== true) {
      this.logger.warn('no id layout pin here and IDENTITY_PIN_BOOTSTRAP is off — not verified');
      return;
    }

    // From here a failure refuses to boot: once a first user lands unpinned, no later boot can pin.
    let persisted: { layoutVersion: number } | undefined;
    try {
      const holdsUsers = (await this.withinTimeout(this.db.select({ id: users.id }).from(users).limit(1))).length > 0;
      if (holdsUsers) {
        this.logger.warn('id layout pin not written — this database already holds users minted under no pin');
        return;
      }
      // Concurrent first boots race here rather than in a read-then-write gap; the loser re-reads
      // the winner's pin below.
      [persisted] = await this.withinTimeout(
        this.db
          .insert(identityKeyPin)
          .values({ id: PIN_ROW_ID, layoutVersion: LAYOUT_VERSION })
          .onConflictDoNothing()
          .returning({ layoutVersion: identityKeyPin.layoutVersion }),
      );
    } catch (error) {
      throw new Error(`id layout pin not written: ${toError(error).message}`, { cause: error });
    }
    if (persisted) {
      this.logger.info({ layoutVersion: LAYOUT_VERSION }, 'id layout pinned — no layout was pinned here before');
      return;
    }

    const pinned = await this.readPin();
    if (pinned === 'absent') this.logger.warn('id layout pin disappeared while being read — not verified');
    if (typeof pinned === 'object') assertLayoutMatches(pinned.layoutVersion);
  }
}

function assertLayoutMatches(pinned: number): void {
  const mismatch = identityLayoutMismatch(pinned);
  if (mismatch !== null) throw new Error(mismatch);
}
