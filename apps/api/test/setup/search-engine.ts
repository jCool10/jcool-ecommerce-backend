import type { INestApplication } from '@nestjs/common';
import { Client } from '@elastic/elasticsearch';
import { ElasticsearchContainer } from '@testcontainers/elasticsearch';
import { CATALOG_SEARCH, type CatalogSearchPort } from '../../src/modules/catalog/application/ports';
import { PRODUCTS_ALIAS, PRODUCTS_INDEX_PREFIX } from '../../src/modules/catalog/infrastructure/search/index-settings';

const SEARCH_IMAGE = 'docker.elastic.co/elasticsearch/elasticsearch:9.5.4';
// The module writes -Xmx2G into this exact file; overwriting it leaves one heap setting, not two.
const HEAP_OPTIONS_FILE = '/usr/share/elasticsearch/config/jvm.options.d/elasticsearch-default-memory-vm.options';
const SEARCH_PASSWORD = 'e2e-search-password-not-a-secret';

// A port nothing listens on, so a connection is refused immediately. Preferred over stopping the
// container mid-suite, which races the requests still in flight.
export const UNREACHABLE_SEARCH_URL = 'http://127.0.0.1:1';

export interface StartedSearchEngine {
  url: string;
  username: string;
  password: string;
  /** Superuser access, for arranging and inspecting indices behind the adapter's back. */
  client: Client;
  stop: () => Promise<void>;
}

export async function startSearchEngine(): Promise<StartedSearchEngine> {
  const container = await new ElasticsearchContainer(SEARCH_IMAGE)
    .withPassword(SEARCH_PASSWORD)
    .withEnvironment({ 'action.auto_create_index': 'false' })
    .withCopyContentToContainer([{ content: '-Xms512m\n-Xmx512m\n', target: HEAP_OPTIONS_FILE }])
    .start();

  const auth = { username: container.getUsername(), password: container.getPassword() };
  const client = new Client({ node: container.getHttpUrl(), auth });
  return {
    url: container.getHttpUrl(),
    ...auth,
    client,
    stop: async () => {
      await client.close();
      await container.stop();
    },
  };
}

export function searchEnv(engine: StartedSearchEngine): Record<string, string> {
  return {
    SEARCH_ENABLED: 'true',
    SEARCH_URL: engine.url,
    SEARCH_USERNAME: engine.username,
    SEARCH_PASSWORD: engine.password,
  };
}

/** By name: the engine refuses a wildcard delete. */
export async function dropSearchIndices(engine: StartedSearchEngine): Promise<void> {
  const indices = Object.keys(await engine.client.indices.get({ index: `${PRODUCTS_INDEX_PREFIX}*` }));
  if (indices.length > 0) {
    await engine.client.indices.delete({ index: indices });
  }
}

/**
 * Postgres is truncated per test but the engine is not. A fresh physical index rather than a
 * delete-by-query, because a deleted document's version outlives the delete and would refuse the
 * next case's write at a lower one.
 */
export async function resetSearchIndex(app: INestApplication, engine: StartedSearchEngine): Promise<void> {
  await dropSearchIndices(engine);
  await app.get<CatalogSearchPort>(CATALOG_SEARCH).ensureIndex();
}

/** A write becomes searchable on the next refresh, up to a second later. */
export async function refreshSearchIndex(engine: StartedSearchEngine): Promise<void> {
  await engine.client.indices.refresh({ index: PRODUCTS_ALIAS });
}
