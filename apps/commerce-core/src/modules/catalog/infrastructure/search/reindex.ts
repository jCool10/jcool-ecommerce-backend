import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import * as schema from '@commerce-core/database/schema';
import type { CatalogSearchPort, ProductRepositoryPort } from '../../application/ports';
import { DrizzleProductRepository } from '../drizzle-product.repository';
import { MeilisearchCatalogSearch } from './meilisearch-catalog-search.adapter';
import { reindexAll } from './reindex-runner';

// Deliberately not the full app, so no queue consumers or scheduled sweeps run for the command's
// lifetime. ClsService is provided but never active here, so the DB query counter it feeds no-ops.
//
// Every provider listed here must declare its dependencies with an explicit @Inject (or a factory's
// `inject` array): tsx compiles with esbuild, which emits no decorator metadata, so a dependency
// inferred from a constructor's parameter type arrives as undefined and only fails at runtime.
@Module({
  imports: [ConfigModule.forRoot(), ClsModule.forRoot({ global: true }), DrizzleModule.forRoot(schema)],
  providers: [DrizzleProductRepository, MeilisearchCatalogSearch],
})
class ReindexContext {}

async function reindex(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const app = await NestFactory.createApplicationContext(ReindexContext, { logger: ['error', 'warn'] });
  try {
    // The adapter is a silent no-op when search is off, which for an on-demand rebuild would report
    // success over an untouched index — the one failure this command must never hide.
    if (app.get(ConfigService).get<boolean>('search.enabled') !== true) {
      throw new Error('SEARCH_ENABLED is not "true": the search adapter would no-op and index nothing');
    }

    // The non-caching repository on purpose: a rebuild reads the source of truth, never a snapshot.
    const repo: ProductRepositoryPort = app.get(DrizzleProductRepository);
    const search: CatalogSearchPort = app.get(MeilisearchCatalogSearch);

    const indexed = await reindexAll(repo, search, { reset });
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
