import type { INestApplication } from '@nestjs/common';
import { CacheService } from '../../src/shared/cache';
import { CATALOG_CACHE_VERSION_KEY } from '../../src/modules/catalog/infrastructure/catalog-cache.keys';

/**
 * `resetDatabase` truncates Postgres only, and fixtures insert straight through Drizzle (bypassing
 * the admin path that would invalidate), so without this a suite reads the previous test's rows
 * out of Redis.
 */
export async function resetCatalogCache(app: INestApplication): Promise<void> {
  await app.get(CacheService).bumpCounter(CATALOG_CACHE_VERSION_KEY);
}
