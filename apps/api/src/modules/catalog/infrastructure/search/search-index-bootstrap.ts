import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CATALOG_SEARCH, type CatalogSearchPort } from '../../application/ports';
import { logShapeOf } from './search-engine-error';

// Long enough for a merely slow engine, short enough that an unreachable one never holds a deploy open.
const PROVISION_TIMEOUT_MS = 5_000;

const LOG_CONTEXT = 'SearchIndexBootstrap';

/**
 * Creates the index behind its alias at boot, or adds the fields a deploy introduced to the one
 * already there, so the first write never meets a missing alias or an unknown field. A changed
 * type or analyzer fails here and is logged: that deploy needs a rebuild. Best-effort and time-boxed
 * on purpose — a failed or slow attempt leaves it to the next restart or to `search:reindex`.
 */
@Injectable()
export class SearchIndexBootstrap implements OnModuleInit {
  constructor(
    @Inject(CATALOG_SEARCH) private readonly search: CatalogSearchPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async onModuleInit(): Promise<void> {
    const provisioning = this.search.ensureIndex().catch((error: unknown) => {
      this.logger.warn(
        { error: logShapeOf(error) },
        'search index provisioning failed; search returns empty until it succeeds',
      );
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          { timeoutMs: PROVISION_TIMEOUT_MS },
          'search index provisioning exceeded its deadline; continuing without it',
        );
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
