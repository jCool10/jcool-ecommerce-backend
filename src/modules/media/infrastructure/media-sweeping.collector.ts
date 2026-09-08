import { Logger, type Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { count, eq } from 'drizzle-orm';
import type { Gauge } from 'prom-client';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { AssetStatus } from '../domain/asset-status';
import { mediaAssets } from './schema/media.schema';

// Rows the sweep claimed but never finished deleting. A brief non-zero reading is one pass in
// flight; a reading that stays up means the bucket is refusing deletes, and every one of those rows
// is an object still being paid for. There is deliberately no way back to READY: nothing here can
// know whether the bytes survived, and guessing wrong puts a 404 on a product page.
export const MEDIA_ASSETS_SWEEPING = 'media_assets_sweeping';

const SCRAPE_TIMEOUT_MS = 2_000;

const logger = new Logger('MediaSweepingCollector');

async function observe(gauge: Gauge<string>, db: DrizzleDB): Promise<void> {
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
    logger.warn(`media sweeping scrape failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  } finally {
    clearTimeout(timer);
  }
}

export const MEDIA_SWEEPING_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: MEDIA_ASSETS_SWEEPING,
    help: 'Media assets the sweep has claimed but not yet deleted. Sustained above zero means storage deletes are failing and the objects behind those rows are still being stored.',
    inject: [DRIZZLE],
    collect(this: Gauge<string>, db: DrizzleDB) {
      return observe(this, db);
    },
  }),
];
