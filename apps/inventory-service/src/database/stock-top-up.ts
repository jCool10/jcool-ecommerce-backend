import { ClsServiceManager } from 'nestjs-cls';
import { Pool } from 'pg';
import { IdServiceHttpAdapter } from '@jcool/platform/identity';

/** Load tests never pay, so their holds outlive a run; a test that needs scarcity seeds its own level. */
export const SEEDED_ON_HAND = 1_000_000_000;

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

export class CatalogUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CatalogUnavailableError';
  }
}

export interface StockTopUpSummary {
  listed: number;
  inserted: number;
  present: number;
}

interface ProductPage {
  items: { variants: { id: string }[] }[];
  totalPages: number;
}

function isProductPage(body: unknown): body is ProductPage {
  const page = body as Partial<ProductPage> | null;
  return (
    Array.isArray(page?.items) &&
    typeof page.totalPages === 'number' &&
    page.items.every(
      (product) => Array.isArray(product?.variants) && product.variants.every((v) => typeof v?.id === 'string'),
    )
  );
}

/** Every variant the public catalog lists. One failed page fails the whole walk, so nothing is half-seeded. */
export async function listCatalogVariantIds(catalogUrl: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
    const url = new URL('/products', catalogUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new CatalogUnavailableError(`${url.href} did not answer`, { cause: error });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new CatalogUnavailableError(`${url.href} answered ${response.status}`);
    if (!isProductPage(body)) throw new CatalogUnavailableError(`${url.href} answered something other than a page`);

    for (const product of body.items) {
      for (const variant of product.variants) ids.add(variant.id);
    }
    totalPages = body.totalPages;
  }
  return [...ids];
}

/**
 * Inserts a level for each variant that has none and touches nothing else: an operator's count and the
 * holds against it always win. Ids are minted before the statement, so no lock waits on the id service.
 */
export async function topUpStock(
  pool: Pool,
  variantIds: string[],
  mint: (count: number) => Promise<string[]>,
): Promise<StockTopUpSummary> {
  const { rows } = await pool.query<{ variantId: string }>(
    'SELECT variant_id::text AS "variantId" FROM stock_levels WHERE variant_id = ANY($1::bigint[])',
    [variantIds],
  );
  const present = new Set(rows.map((row) => row.variantId));
  const missing = variantIds.filter((variantId) => !present.has(variantId));
  if (missing.length === 0) {
    return { listed: variantIds.length, inserted: 0, present: variantIds.length };
  }

  const ids = await mint(missing.length);
  // DO NOTHING covers a level an operator set between the read above and this statement.
  const { rowCount } = await pool.query(
    `INSERT INTO stock_levels (id, variant_id, quantity_on_hand)
     SELECT id, variant_id, $3 FROM unnest($1::bigint[], $2::bigint[]) AS seeded(id, variant_id)
     ON CONFLICT (variant_id) DO NOTHING`,
    [ids, missing, SEEDED_ON_HAND],
  );
  const inserted = rowCount ?? 0;
  return { listed: variantIds.length, inserted, present: variantIds.length - inserted };
}

export interface SeedStockOptions {
  /** The pre-deploy mode: a catalog that cannot be listed skips the seed instead of failing the deploy. */
  bestEffort: boolean;
  env?: Record<string, string | undefined>;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** The exit code. Faults other than the catalog's (database, id service) are thrown. */
export async function runSeedStock({
  bestEffort,
  env = process.env,
  log = console,
}: SeedStockOptions): Promise<number> {
  const { DATABASE_URL: databaseUrl, CATALOG_PUBLIC_URL: catalogUrl, ID_SERVICE_URL: idServiceUrl } = env;
  if (!databaseUrl || !catalogUrl || !idServiceUrl) {
    log.error('stock seed: DATABASE_URL, CATALOG_PUBLIC_URL and ID_SERVICE_URL are required');
    return 1;
  }

  let variantIds: string[];
  try {
    variantIds = await listCatalogVariantIds(catalogUrl);
  } catch (error) {
    if (!(error instanceof CatalogUnavailableError)) throw error;
    if (bestEffort) {
      log.warn(`stock seed skipped, nothing written: ${error.message}`);
      return 0;
    }
    log.error(`stock seed failed: ${error.message}`);
    return 1;
  }
  if (variantIds.length === 0 && !bestEffort) {
    log.error(
      `stock seed failed: ${catalogUrl} lists no variants. Its list cache can answer an empty page for up to ` +
        'CATALOG_CACHE_TTL_SEC + CACHE_STALE_WINDOW_SEC after products are added; run it again after that.',
    );
    return 1;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  // Without an 'error' listener a dead idle client crashes the process.
  pool.on('error', (error: Error) => log.error('stock seed: pool client error:', error.message));
  try {
    const { listed, inserted, present } = await topUpStock(pool, variantIds, idMinter(idServiceUrl));
    log.log(`stock seed listed=${listed} inserted=${inserted} present=${present}`);
    return 0;
  } finally {
    await pool.end();
  }
}

// One attempt, no breaker: a script that fails is simply run again.
function idMinter(url: string): (count: number) => Promise<string[]> {
  const adapter = new IdServiceHttpAdapter(
    { url, timeoutMs: REQUEST_TIMEOUT_MS, caller: 'inventory-service' },
    { run: (task) => task() },
    ClsServiceManager.getClsService(),
  );
  return (count) => adapter.mint(count);
}
