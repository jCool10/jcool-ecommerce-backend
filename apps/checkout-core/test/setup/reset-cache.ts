import type { INestApplication } from '@nestjs/common';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { CATALOG_CACHE_VERSION_KEY } from '../../src/modules/catalog/infrastructure/catalog-cache.keys';

/**
 * `resetDatabase` truncates Postgres only, and fixtures insert straight through Drizzle (bypassing
 * the admin path that would invalidate), so without this a suite reads the previous test's rows
 * out of Redis.
 *
 * Sets the generation rather than incrementing it, because incrementing only lands somewhere unused
 * while the counter is never deleted — and a spec that pins what an `allkeys-lru` eviction does to
 * this key deletes it on purpose. After that the next `INCR` restarts at 1, back inside a generation
 * whose entries another catalog spec on this worker may still have live, and the suite reads that
 * spec's rows. A timestamp is monotonic across the run and unreachable by counting, so every reset
 * lands in a generation nothing has ever written to.
 *
 * Two properties worth stating rather than discovering. The generation is unique only at >1ms
 * spacing — two resets inside one millisecond reuse it — which holds today because every call site
 * is preceded by a `resetDatabase` or an app boot, and no e2e spec fakes the clock. And this is
 * fail-closed where the old `CacheService` path was fail-open: `RedisService` builds its client with
 * `enableOfflineQueue: false`, so a reset issued while a Redis-outage test's client is still
 * reconnecting rejects the hook instead of logging and continuing.
 */
export async function resetCatalogCache(app: INestApplication): Promise<void> {
  await app.get(RedisService).getClient().set(CATALOG_CACHE_VERSION_KEY, String(Date.now()));
}
