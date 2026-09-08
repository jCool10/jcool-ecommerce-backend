import type { INestApplication } from '@nestjs/common';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CATALOG_SEARCH, type CatalogSearchPort } from '../../src/modules/catalog/application/ports';

const SEARCH_IMAGE = 'getmeili/meilisearch:v1.53.1';
const SEARCH_PORT = 7700;

// A port nothing listens on, so a connection is refused immediately. Preferred over stopping the
// container mid-suite, which races the requests still in flight.
export const UNREACHABLE_SEARCH_URL = 'http://127.0.0.1:1';

export interface StartedSearchEngine {
  url: string;
  stop: () => Promise<void>;
}

/**
 * There is no `@testcontainers/meilisearch`, so this is a GenericContainer whose readiness is the
 * engine's own `/health` — returning before that leaves the first request racing the boot.
 */
export async function startSearchEngine(): Promise<StartedSearchEngine> {
  const container: StartedTestContainer = await new GenericContainer(SEARCH_IMAGE)
    .withExposedPorts(SEARCH_PORT)
    // Keyless, matching how docker-compose runs it locally; the engine allows that in this mode only.
    .withEnvironment({ MEILI_ENV: 'development' })
    .withWaitStrategy(Wait.forHttp('/health', SEARCH_PORT))
    .start();

  return {
    url: `http://${container.getHost()}:${container.getMappedPort(SEARCH_PORT)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Postgres is truncated per test but the engine is not, so without this a document outlives the row
 * it came from and the next test searches a catalog that no longer exists. Resolves only once the
 * engine has applied it — every adapter write awaits its task — so no assertion has to poll.
 */
export async function resetSearchIndex(app: INestApplication): Promise<void> {
  await app.get<CatalogSearchPort>(CATALOG_SEARCH).resetIndex();
}
