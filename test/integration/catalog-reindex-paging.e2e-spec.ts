import type { INestApplication } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleProductRepository } from '@modules/catalog/infrastructure';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';
import { seedProducts } from '../setup/fixtures/catalog.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const PAGE = 10;
// More pages than any fixture here needs: a cursor that fails to advance pages forever, and a
// thrown error names that better than a hung suite does.
const RUNAWAY_PAGES = 20;

// The keyset scan behind the reindex backstop, driven against real Postgres — the only tier where
// the cursor's round trip through the driver is exercised. A timestamp cursor cannot survive that
// trip: `created_at` holds microseconds and a JS Date carries milliseconds, so the bound value
// lands before the row it came from and the seek re-serves it.
describe('Catalog reindex paging (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: DrizzleProductRepository;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    repo = app.get(DrizzleProductRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // Postgres stores created_at to the microsecond; every row is stamped to the same one, so a
  // timestamp-keyed cursor has no tiebreak left to advance on.
  async function collapseCreatedAt(productIds: string[]): Promise<void> {
    await db
      .update(schema.products)
      .set({ createdAt: sql`timestamptz '2026-08-12 09:41:00.123456+00'` })
      .where(inArray(schema.products.id, productIds));
  }

  async function scanAll(): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page > RUNAWAY_PAGES) {
        throw new Error(`scan did not terminate after ${RUNAWAY_PAGES} pages`);
      }
      const items = await repo.findActiveAfter(cursor, PAGE);
      seen.push(...items.map((product) => product.id));
      if (items.length < PAGE) {
        return seen;
      }
      cursor = items[items.length - 1].id;
    }
  }

  it('serves every ACTIVE product exactly once when a whole page shares one created_at', async () => {
    const { productIds } = await seedProducts(app, 25);
    await collapseCreatedAt(productIds);

    const seen = await scanAll();

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual([...productIds].sort());
  });

  it('excludes the cursor row itself from the next page', async () => {
    const { productIds } = await seedProducts(app, 3);
    await collapseCreatedAt(productIds);

    const [first] = await repo.findActiveAfter(null, 1);
    const next = await repo.findActiveAfter(first.id, PAGE);

    expect(next.map((product) => product.id)).not.toContain(first.id);
    expect(next).toHaveLength(2);
  });

  it('skips products that are not ACTIVE', async () => {
    const { categoryId, productIds: active } = await seedProducts(app, 5);
    const { productIds: drafts } = await seedProducts(app, 5, { categoryId, status: 'DRAFT' });
    await collapseCreatedAt([...active, ...drafts]);

    const seen = await scanAll();

    expect([...seen].sort()).toEqual([...active].sort());
  });
});
