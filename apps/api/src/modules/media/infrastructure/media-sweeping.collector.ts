import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { count, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { toError } from '@shared/kernel/to-error';
import { AssetStatus } from '../domain/asset-status';
import { mediaAssets } from './schema/media.schema';

const LOG_CONTEXT = 'MediaSweepingCollector';

// A brief non-zero reading is one pass in flight; a reading that stays up means the bucket is
// refusing deletes and every one of those rows is an object still being paid for. There is
// deliberately no way back from SWEEPING: nothing here can know whether the bytes survived, and
// guessing wrong puts a 404 on a product page.
export const MEDIA_ASSETS_SWEEPING = 'media_assets_sweeping';

const SCRAPE_TIMEOUT_MS = 2_000;

async function observe(gauge: Gauge<string>, db: DrizzleDB, logger: PinoLogger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [row] = await Promise.race([
      db.select({ total: count() }).from(mediaAssets).where(eq(mediaAssets.status, AssetStatus.SWEEPING)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`query exceeded ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    gauge.set(row?.total ?? 0);
  } catch (caught) {
    // A rejection here would fail the whole /metrics response and take every unrelated series down
    // with it, at exactly the moment the database is the thing being investigated.
    logger.warn({ context: LOG_CONTEXT, err: toError(caught) }, 'media sweeping scrape failed');
  } finally {
    clearTimeout(timer);
  }
}

export const MEDIA_SWEEPING_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: MEDIA_ASSETS_SWEEPING,
    help: 'Media assets the sweep has claimed but not yet deleted. Sustained above zero means storage deletes are failing and the objects behind those rows are still being stored.',
    inject: [DRIZZLE, PinoLogger],
    collect(this: Gauge<string>, db: DrizzleDB, logger: PinoLogger) {
      return observe(this, db, logger);
    },
  }),
];
