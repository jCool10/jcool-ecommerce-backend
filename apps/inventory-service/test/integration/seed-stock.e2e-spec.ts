import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEEDED_ON_HAND, runSeedStock } from '../../src/database/stock-top-up';
import { CatalogFixture } from '../setup/catalog-fixture';
import { idServiceStub, testId } from '../setup/id-service-stub';
import { resetDatabase } from '../setup/reset-database';
import { workerDatabaseUrl } from '../setup/worker-resources';

const NOTHING_LISTENS = 'http://127.0.0.1:1';
// Two variants per product, so this spans two catalog pages of 100 products.
const TWO_PAGES = 250;

interface Level {
  id: string;
  variantId: string;
  onHand: number;
  xmin: string;
}

describe('Stock seed (integration, real Postgres)', () => {
  let pool: Pool;
  let catalog: CatalogFixture;
  let idServiceUrl: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: workerDatabaseUrl(), max: 2 });
    catalog = await CatalogFixture.start();
    idServiceUrl = (await idServiceStub()).url;
  });

  afterAll(async () => {
    await pool.end();
    await catalog.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    catalog.list([]);
  });

  async function seed({ bestEffort = false, catalogUrl = catalog.url } = {}) {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = await runSeedStock({
      bestEffort,
      env: { DATABASE_URL: workerDatabaseUrl(), CATALOG_PUBLIC_URL: catalogUrl, ID_SERVICE_URL: idServiceUrl },
      log,
    });
    return { code, log };
  }

  // xmin moves on any write, so an unchanged snapshot means the row was not touched.
  async function levels(): Promise<Level[]> {
    const { rows } = await pool.query<Level>(
      `SELECT id::text, variant_id::text AS "variantId", quantity_on_hand AS "onHand", xmin::text
         FROM stock_levels ORDER BY variant_id`,
    );
    return rows;
  }

  const variants = (count: number): string[] => Array.from({ length: count }, () => testId());

  it('inserts a level at the seeded count for every variant on every page, and reports it', async () => {
    const listed = variants(TWO_PAGES);
    catalog.list(listed);

    const { code, log } = await seed();

    const seeded = await levels();
    expect(code).toBe(0);
    expect(seeded.map((level) => level.variantId).sort()).toEqual([...listed].sort());
    expect(seeded.every((level) => level.onHand === SEEDED_ON_HAND)).toBe(true);
    expect(log.log).toHaveBeenCalledWith(`stock seed listed=${TWO_PAGES} inserted=${TWO_PAGES} present=0`);
  });

  it('keeps a level an operator already set', async () => {
    const [counted, ...fresh] = variants(3);
    await pool.query('INSERT INTO stock_levels (id, variant_id, quantity_on_hand) VALUES ($1, $2, 7)', [
      testId(),
      counted,
    ]);
    catalog.list([counted, ...fresh]);

    const { code, log } = await seed();

    const byVariant = new Map((await levels()).map((level) => [level.variantId, level.onHand]));
    expect(code).toBe(0);
    expect(byVariant.get(counted)).toBe(7);
    expect(fresh.map((variantId) => byVariant.get(variantId))).toEqual([SEEDED_ON_HAND, SEEDED_ON_HAND]);
    expect(log.log).toHaveBeenCalledWith('stock seed listed=3 inserted=2 present=1');
  });

  it('writes nothing when a later page fails under best effort, and seeds everything on the next run', async () => {
    const listed = variants(TWO_PAGES);
    catalog.list(listed);
    catalog.failOnPage(2);

    const skipped = await seed({ bestEffort: true });

    expect(skipped.code).toBe(0);
    expect(skipped.log.warn).toHaveBeenCalledOnce();
    expect(await levels()).toEqual([]);

    catalog.list(listed);
    expect((await seed({ bestEffort: true })).code).toBe(0);
    expect(await levels()).toHaveLength(TWO_PAGES);
  });

  it('skips under best effort but fails a strict run when the catalog does not answer', async () => {
    expect((await seed({ bestEffort: true, catalogUrl: NOTHING_LISTENS })).code).toBe(0);
    expect((await seed({ catalogUrl: NOTHING_LISTENS })).code).toBe(1);
    expect(await levels()).toEqual([]);
  });

  // The api's list cache can answer an empty first page for a while after products are added.
  it('fails a strict run on a catalog that lists no variants', async () => {
    const { code, log } = await seed();

    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('CATALOG_CACHE_TTL_SEC'));
  });

  it('writes nothing on a rerun over the same catalog, and only the new variant once one is added', async () => {
    const listed = variants(3);
    catalog.list(listed);
    await seed();
    const before = await levels();

    const rerun = await seed();

    expect(rerun.log.log).toHaveBeenCalledWith('stock seed listed=3 inserted=0 present=3');
    expect(await levels()).toEqual(before);

    const [added] = variants(1);
    catalog.list([...listed, added]);
    const grown = await seed();

    const after = await levels();
    expect(grown.log.log).toHaveBeenCalledWith('stock seed listed=4 inserted=1 present=3');
    expect(after.filter((level) => level.variantId !== added)).toEqual(before);
    expect(after.find((level) => level.variantId === added)?.onHand).toBe(SEEDED_ON_HAND);
  });
});
