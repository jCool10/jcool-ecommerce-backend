import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import { toSearchableProduct } from '../../application/catalog-search.mapper';
import type { CatalogSearchPort, ProductRepositoryPort } from '../../application/ports';
import { DrizzleProductRepository } from '../drizzle-product.repository';
import { MeilisearchCatalogSearch } from './meilisearch-catalog-search.adapter';

// Minimal context for the reindex CLI: config + database + the search adapter only, deliberately
// NOT the full app — so no queue consumers or scheduled sweeps run for the command's lifetime.
// ClsService is provided but never active here, so the DB query counter it feeds is a no-op.
//
// Every provider listed here must declare its dependencies with an explicit @Inject (or a factory's
// `inject` array): tsx compiles with esbuild, which emits no decorator metadata, so a dependency
// inferred from a constructor's parameter type arrives as undefined and only fails at runtime.
@Module({
  imports: [ConfigModule, ClsModule.forRoot({ global: true }), DrizzleModule],
  providers: [DrizzleProductRepository, MeilisearchCatalogSearch],
})
class ReindexContext {}

// The search index is a derived, read-only replica of Postgres (the single source of truth). This
// reads every ACTIVE product straight from the database — the non-caching repository, so a rebuild is
// never served a stale snapshot — and upserts by id, making re-runs idempotent. A default run re-adds
// every current ACTIVE product but does NOT remove documents for products that have since left the
// ACTIVE set; pass `--reset` to clear the index first for a clean, authoritative rebuild (at the cost
// of a brief empty-search window while it reloads).

const PAGE_SIZE = 500;

async function reindex(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const app = await NestFactory.createApplicationContext(ReindexContext, { logger: ['error', 'warn'] });
  try {
    // The adapter is a silent no-op when search is off, which for an on-demand rebuild would report
    // success over an untouched index — the one failure this command must never hide.
    if (app.get(ConfigService).get<boolean>('search.enabled') !== true) {
      throw new Error('SEARCH_ENABLED is not "true": the search adapter would no-op and index nothing');
    }

    const repo: ProductRepositoryPort = app.get(DrizzleProductRepository);
    const search: CatalogSearchPort = app.get(MeilisearchCatalogSearch);

    await search.ensureIndex();
    if (reset) await search.resetIndex();

    let page = 1;
    let indexed = 0;
    for (;;) {
      const { items, total } = await repo.findManyActive({ page, pageSize: PAGE_SIZE });
      if (items.length === 0) break;
      await search.bulkIndex(items.map(toSearchableProduct));
      indexed += items.length;
      if (indexed >= total) break;
      page += 1;
    }

    console.log(`Reindex complete: ${indexed} ACTIVE products indexed${reset ? ' (index reset first)' : ''}`);
  } finally {
    await app.close();
  }
}

// Explicit exit so lingering client handles (pg pool) can't keep the process alive after close.
void reindex()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Reindex failed:', error);
    process.exit(1);
  });
