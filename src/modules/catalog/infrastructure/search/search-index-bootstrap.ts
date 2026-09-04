import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CATALOG_SEARCH, type CatalogSearchPort } from '../../application/ports';

// Long enough for an engine that is merely slow to start, short enough that an unreachable one never
// holds a deploy open.
const PROVISION_TIMEOUT_MS = 5_000;

/**
 * Apply the index settings at boot so the engine is never left holding an index it auto-created on
 * the first write. Such an index has no `filterableAttributes`, so the read filter is rejected, and
 * because a failed search degrades to an empty result the whole catalog reads as "matches nothing" —
 * with the rejection visible only as a log line.
 *
 * Best-effort and time-boxed: compose deliberately does not make the app depend on the engine, and
 * booting is not the moment to start. A failed or slow attempt leaves the settings to the next
 * restart or to `search:reindex`, which applies them too.
 */
@Injectable()
export class SearchIndexBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SearchIndexBootstrap.name);

  constructor(@Inject(CATALOG_SEARCH) private readonly search: CatalogSearchPort) {}

  async onModuleInit(): Promise<void> {
    const provisioning = this.search.ensureIndex().catch((error: unknown) => {
      this.logger.warn(
        `search index provisioning failed; search returns empty until it succeeds: ${describeError(error)}`,
      );
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(`search index provisioning exceeded ${PROVISION_TIMEOUT_MS}ms; continuing without it`);
        resolve();
      }, PROVISION_TIMEOUT_MS);
    });

    try {
      await Promise.race([provisioning, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
