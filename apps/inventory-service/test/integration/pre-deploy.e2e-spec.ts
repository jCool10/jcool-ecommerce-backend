import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPreDeploy } from '../../src/database/pre-deploy';
import { CatalogFixture } from '../setup/catalog-fixture';
import { idServiceStub, testId } from '../setup/id-service-stub';
import { resetDatabase } from '../setup/reset-database';
import { workerDatabaseUrl } from '../setup/worker-resources';

const NOTHING_LISTENS = 'http://127.0.0.1:1';

describe('Pre-deploy step (integration, real Postgres)', () => {
  let pool: Pool;
  let catalog: CatalogFixture;
  let idServiceUrl: string;
  let emptyFolder: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: workerDatabaseUrl(), max: 2 });
    catalog = await CatalogFixture.start();
    idServiceUrl = (await idServiceStub()).url;
    emptyFolder = mkdtempSync(join(tmpdir(), 'no-migrations-'));
  });

  afterAll(async () => {
    await pool.end();
    await catalog.close();
    rmSync(emptyFolder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    catalog.list([]);
  });

  async function preDeploy({
    catalogUrl = catalog.url,
    migrationsFolder,
  }: { catalogUrl?: string; migrationsFolder?: string } = {}) {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = await runPreDeploy({
      env: { DATABASE_URL: workerDatabaseUrl(), CATALOG_PUBLIC_URL: catalogUrl, ID_SERVICE_URL: idServiceUrl },
      migrationsFolder,
      log,
    });
    return { code, log };
  }

  const levelCount = async (): Promise<number> =>
    Number((await pool.query<{ count: string }>('SELECT count(*) FROM stock_levels')).rows[0].count);

  it('migrates, then seeds every variant the catalog lists', async () => {
    catalog.list([testId(), testId()]);

    const { code, log } = await preDeploy();

    expect(code).toBe(0);
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^migrations up to date from /));
    expect(log.log).toHaveBeenCalledWith('stock seed listed=2 inserted=2 present=0');
    expect(await levelCount()).toBe(2);
  });

  it('passes without seeding when the catalog does not answer', async () => {
    const { code, log } = await preDeploy({ catalogUrl: NOTHING_LISTENS });

    expect(code).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^stock seed skipped, nothing written: /));
    expect(await levelCount()).toBe(0);
  });

  it('fails before seeding when the migrations folder holds no .sql file', async () => {
    catalog.list([testId()]);

    const { code, log } = await preDeploy({ migrationsFolder: emptyFolder });

    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(`no .sql migrations found in ${emptyFolder}`);
    expect(await levelCount()).toBe(0);
  });
});
