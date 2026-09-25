import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ObservabilityLoggerModule } from '@jcool/platform/observability';
import type { OutboundCall } from '@jcool/platform/resilience';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import * as schema from '@shared/infrastructure/database/schema';
import { type CatalogSearchPort, type ProductSearchStatePort, RebuildInProgressError } from '../../application/ports';
import { DrizzleProductRepository } from '../drizzle-product.repository';
import {
  ElasticsearchCatalogSearch,
  SEARCH_ENGINE_CALLS,
  type SearchEngineCalls,
} from './elasticsearch-catalog-search.adapter';
import { rebuildIndex } from './reindex-runner';

// An operator command fails on the first error rather than learning an outage; the breaker factory
// also infers its dependencies from constructor types, which tsx cannot supply.
const passThrough: OutboundCall = { run: (task) => task() };
const unguarded: SearchEngineCalls = { read: passThrough, write: passThrough };

// Deliberately not the full app, so no queue consumers or scheduled sweeps run for the command's
// lifetime. ClsService is provided but never active here, so the DB query counter it feeds no-ops.
//
// Every provider listed here must declare its dependencies with an explicit @Inject (or a factory's
// `inject` array): tsx compiles with esbuild, which emits no decorator metadata, so a dependency
// inferred from a constructor's parameter type arrives as undefined and only fails at runtime.
@Module({
  // DrizzleModule's pool injects PinoLogger, so the logger module has to be here too.
  imports: [
    ConfigModule,
    ClsModule.forRoot({ global: true }),
    ObservabilityLoggerModule,
    DrizzleModule.forRoot({ schema }),
  ],
  providers: [
    DrizzleProductRepository,
    { provide: SEARCH_ENGINE_CALLS, useValue: unguarded },
    ElasticsearchCatalogSearch,
  ],
})
class ReindexContext {}

function parseFlags(): { clearStale: boolean; graceMs: number } {
  const { values } = parseArgs({
    // pnpm forwards the `--` that separates its own flags from the script's.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      // Only when no rebuild is running: it aborts whichever one holds the lock.
      'clear-stale': { type: 'boolean', default: false },
      'grace-seconds': { type: 'string', default: '30' },
    },
  });
  const graceSeconds = values['grace-seconds'];
  if (!/^\d+$/.test(graceSeconds)) {
    throw new Error(`--grace-seconds takes a whole number of seconds, got "${graceSeconds}"`);
  }
  return { clearStale: values['clear-stale'], graceMs: Number(graceSeconds) * 1_000 };
}

// A signal stops the fill at its next page and drops the half-built index, so no lock is left behind.
// Repeats are ignored rather than fatal: tsx and pnpm relay the terminal's Ctrl-C a second time, which
// would otherwise kill the process between releasing the lock and deleting the index.
function interruptOnSignal(): AbortSignal {
  const interrupt = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      if (interrupt.signal.aborted) return;
      console.error(`${name} received: stopping at the next page and dropping the half-built index`);
      interrupt.abort(new Error(`interrupted by ${name}`));
    });
  }
  return interrupt.signal;
}

async function reindex(): Promise<void> {
  const { clearStale, graceMs } = parseFlags();
  const app = await NestFactory.createApplicationContext(ReindexContext, { logger: ['error', 'warn'] });
  try {
    // The adapter is a silent no-op when search is off, which for an on-demand rebuild would report
    // success over an untouched index — the one failure this command must never hide.
    if (app.get(ConfigService).get<boolean>('search.enabled') !== true) {
      throw new Error('SEARCH_ENABLED is not "true": the search adapter would no-op and index nothing');
    }

    // The uncached repository on purpose: a rebuild reads the source of truth, never a snapshot.
    const states: ProductSearchStatePort = app.get(DrizzleProductRepository);
    const search: CatalogSearchPort = app.get(ElasticsearchCatalogSearch);

    if (clearStale) await search.abortRebuild();
    const { documents, tombstones, retired } = await rebuildIndex(states, search, {
      graceMs,
      signal: interruptOnSignal(),
    });
    console.log(
      `Rebuild complete: ${documents} documents and ${tombstones} tombstones; retired ${retired.join(', ') || 'none'}`,
    );
  } finally {
    await app.close();
  }
}

// Explicit exit so lingering client handles (pg pool) can't keep the process alive after close.
void reindex()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Reindex failed:', error);
    if (error instanceof RebuildInProgressError) {
      console.error('If no rebuild is running, a crashed one left its lock behind: rerun with --clear-stale.');
    }
    process.exit(1);
  });
