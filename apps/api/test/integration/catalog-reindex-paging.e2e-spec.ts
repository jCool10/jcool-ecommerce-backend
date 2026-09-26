import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProductSearchState } from '../../src/modules/catalog/application/ports';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure';
import { archiveProduct, seedProducts } from '../setup/fixtures/catalog.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const PAGE = 10;
// More pages than any fixture here needs: a cursor that fails to advance pages forever, and a
// thrown error names that better than a hung suite does.
const RUNAWAY_PAGES = 20;

// The keyset scan behind the reindex, driven against real Postgres: the only tier where the
// cursor's round trip through the driver is exercised.
describe('Catalog reindex paging (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: DrizzleProductRepository;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
    repo = app.get(DrizzleProductRepository);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function scanStates(from: string | null = null): Promise<{ pages: number[]; states: ProductSearchState[] }> {
    const pages: number[] = [];
    const states: ProductSearchState[] = [];
    let cursor = from;
    for (let page = 0; ; page += 1) {
      if (page > RUNAWAY_PAGES) {
        throw new Error(`scan did not terminate after ${RUNAWAY_PAGES} pages`);
      }
      const batch = await repo.findAfter(cursor, PAGE);
      pages.push(batch.length);
      if (batch.length === 0) {
        return { pages, states };
      }
      states.push(...batch);
      cursor = batch[batch.length - 1].id;
    }
  }

  it('returns every product whatever its status, in ascending id order', async () => {
    const { categoryId, productIds: active } = await seedProducts(app, 4);
    const { productIds: drafts } = await seedProducts(app, 4, { categoryId, status: 'DRAFT' });
    const { productIds: archived } = await seedProducts(app, 4, { categoryId, status: 'ARCHIVED' });

    const { states } = await scanStates();

    expect(states.map((entry) => entry.id)).toEqual([...active, ...drafts, ...archived].sort());
    const projected = states.filter((entry) => entry.product !== null).map((entry) => entry.id);
    expect(projected.sort()).toEqual([...active].sort());
  });

  it('pages by cursor and ends with an empty page', async () => {
    const { productIds } = await seedProducts(app, 25);

    const { pages, states } = await scanStates();

    expect(pages).toEqual([PAGE, PAGE, 5, 0]);
    expect(states.map((entry) => entry.id)).toEqual([...productIds].sort());
  });

  it('never skips a row when products are archived on either side of the cursor mid-scan', async () => {
    const { productIds } = await seedProducts(app, 25);
    const ordered = [...productIds].sort();
    const first = await repo.findAfter(null, PAGE);
    const behind = ordered[3];
    const ahead = ordered[PAGE + 5];

    await archiveProduct(app, behind);
    await archiveProduct(app, ahead);
    const { states: rest } = await scanStates(first[first.length - 1].id);

    expect([...first, ...rest].map((entry) => entry.id)).toEqual(ordered);
    expect(rest.find((entry) => entry.id === ahead)?.product).toBeNull();
  });
});
