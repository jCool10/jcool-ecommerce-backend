import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SEARCH,
  type CatalogSearchPort,
  type SearchableProduct,
} from '../../src/modules/catalog/application/ports';
import { PRODUCTS_ALIAS } from '../../src/modules/catalog/infrastructure/search/index-settings';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { CATALOG_EVENT_PRIORITY, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import { createTestCategory, type TestCategory } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal, type TestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import {
  UNREACHABLE_SEARCH_URL,
  refreshSearchIndex,
  resetSearchIndex,
  searchEnv,
  startSearchEngine,
  type StartedSearchEngine,
} from '../setup/search-engine';
import { createTestApp } from '../setup/test-app.factory';

interface SearchHitBody {
  id: string;
  name: string;
  minPriceMinor: number | null;
}

type ProductStatus = 'ACTIVE' | 'DRAFT';

let seq = 0;
const uniq = (): string => `${Date.now()}-${seq++}`;

describe('Catalog search sync (integration, real Postgres + Redis + Elasticsearch)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let queue: Queue<DomainEventJob>;
  let relay: OutboxRelay;
  let processor: DomainEventProcessor;
  let admin: TestPrincipal;
  let category: TestCategory;

  beforeAll(async () => {
    engine = await startSearchEngine();
    ({ app, pool, db } = await createTestAppWithPool(searchEnv(engine)));
    queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
  });

  // The queue is emptied after the truncate, or a job left by the previous case lands on rows that
  // no longer exist.
  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    await resetSearchIndex(app, engine);
    admin = await createTestAdminPrincipal(app);
    category = await createTestCategory(app, 'Sync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object): request.Test => {
    const req = request(app.getHttpServer())[method](path).set(authHeader(admin.accessToken));
    return body ? req.send(body) : req;
  };

  const productBody = (name: string, status: ProductStatus) => ({
    name,
    slug: `sync-${uniq()}`,
    categoryId: category.id,
    status,
  });

  async function createProduct(name: string, status: ProductStatus = 'ACTIVE'): Promise<string> {
    const res = await send('post', '/admin/products', productBody(name, status)).expect(201);
    return (res.body as { id: string }).id;
  }

  async function converge(): Promise<void> {
    await drainDomainEvents(app);
    await refreshSearchIndex(engine);
  }

  async function search(q: string): Promise<SearchHitBody[]> {
    const res = await request(app.getHttpServer())
      .get('/products/search')
      .query({ q, categorySlug: category.slug })
      .expect(200);
    return (res.body as { items: SearchHitBody[] }).items;
  }

  const found = async (q: string): Promise<string[]> => (await search(q)).map((hit) => hit.id).sort();

  async function stored(id: string): Promise<{ version?: number; name?: string; status?: string }> {
    const res = await engine.client.get<Partial<SearchableProduct>>({ index: PRODUCTS_ALIAS, id });
    return { version: res._version, name: res._source?.name, status: res._source?.status };
  }

  async function versionOf(productId: string): Promise<number> {
    const [row] = await db
      .select({ version: schema.products.searchVersion })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    return row.version;
  }

  const inboxRowsFor = (messageId: string) =>
    db.select().from(schema.inbox).where(eq(schema.inbox.messageId, messageId));

  /** Publishes the pending outbox rows and hands back the one job queued for this product. */
  async function relayJobFor(productId: string): Promise<Job<DomainEventJob>> {
    await relay.runOnce(100);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    const mine = jobs.filter((job) => job.data.aggregateId === productId);
    expect(mine).toHaveLength(1);
    return mine[0];
  }

  const searchPort = (): CatalogSearchPort => app.get<CatalogSearchPort>(CATALOG_SEARCH);

  it('makes a created product searchable once its change event is delivered, not before', async () => {
    const sibling = await createProduct('Harbor Lantern');
    await converge();

    const productId = await createProduct('Signal Lantern');
    await refreshSearchIndex(engine);
    expect(await found('Lantern')).toEqual([sibling]);

    await converge();
    expect(await found('Lantern')).toEqual([sibling, productId].sort());
  });

  async function createWhileEngineUnreachable(name: string): Promise<string> {
    const blind = await createTestApp({ ...searchEnv(engine), SEARCH_URL: UNREACHABLE_SEARCH_URL });
    try {
      const res = await request(blind.getHttpServer())
        .post('/admin/products')
        .set(authHeader(admin.accessToken))
        .send(productBody(name, 'ACTIVE'))
        .expect(201);
      return (res.body as { id: string }).id;
    } finally {
      await blind.close();
    }
  }

  it('accepts an admin write while the engine is unreachable and indexes it once the engine answers', async () => {
    const productId = await createWhileEngineUnreachable('Stranded Beacon');

    const events = await db
      .select({ eventType: schema.outbox.eventType, publishedAt: schema.outbox.publishedAt })
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, productId));
    expect(events).toEqual([{ eventType: 'catalog.product.changed', publishedAt: null }]);

    await converge();
    expect(await found('Beacon')).toEqual([productId]);
  });

  it('retries a delivery whose engine write failed, leaving no claim behind in between', async () => {
    const productId = await createProduct('Retried Compass');
    const job = await relayJobFor(productId);
    vi.spyOn(searchPort(), 'write').mockRejectedValueOnce(new Error('search engine unavailable'));

    await expect(processor.process(job.data)).rejects.toThrow('search engine unavailable');
    expect(await inboxRowsFor(job.data.outboxId)).toEqual([]);

    await expect(processor.process(job.data)).resolves.toBe('processed');
    expect(await inboxRowsFor(job.data.outboxId)).toHaveLength(1);
    await refreshSearchIndex(engine);
    expect(await found('Compass')).toEqual([productId]);
  });

  it('skips a redelivered message it already applied and leaves the document as it was', async () => {
    const productId = await createProduct('Echo Sextant');
    const job = await relayJobFor(productId);
    await expect(processor.process(job.data)).resolves.toBe('processed');
    await refreshSearchIndex(engine);
    const applied = await stored(productId);
    expect(applied).toEqual({ version: 0, name: 'Echo Sextant', status: 'ACTIVE' });

    await expect(processor.process(job.data)).resolves.toBe('duplicate');
    await refreshSearchIndex(engine);

    expect(await stored(productId)).toEqual(applied);
  });

  // Delivery one reads version 1 and stalls inside its engine write; delivery two reads and writes
  // version 2; then delivery one lands. Without external versioning its older state would win.
  it('keeps the newest state when an older delivery lands after a newer one', async () => {
    const productId = await createProduct('Drifting Buoy');
    await converge();

    await send('patch', `/admin/products/${productId}`, { name: 'Drifting Buoy Alpha' }).expect(200);
    const first = await relayJobFor(productId);

    const port = searchPort();
    const write = port.write.bind(port) as CatalogSearchPort['write'];
    let entered!: () => void;
    const stalled = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(port, 'write').mockImplementationOnce(async (changes) => {
      entered();
      await gate;
      return write(changes);
    });

    const late = processor.process(first.data);
    await stalled;

    await send('patch', `/admin/products/${productId}`, { name: 'Drifting Buoy Bravo' }).expect(200);
    await first.remove();
    const second = await relayJobFor(productId);
    await expect(processor.process(second.data)).resolves.toBe('processed');

    release();
    await expect(late).resolves.toBe('processed');
    await refreshSearchIndex(engine);

    expect(await versionOf(productId)).toBe(2);
    expect(await stored(productId)).toEqual({ version: 2, name: 'Drifting Buoy Bravo', status: 'ACTIVE' });
  });

  it('takes an archived product out of search and holds a tombstone at its archived version', async () => {
    const productId = await createProduct('Retired Anchor');
    await converge();
    expect(await found('Anchor')).toEqual([productId]);

    await send('delete', `/admin/products/${productId}`).expect(200);
    await converge();

    expect(await found('Anchor')).toEqual([]);
    expect(await stored(productId)).toEqual({ version: await versionOf(productId), status: 'INACTIVE' });
  });

  it('keeps a draft out of search until its publish is delivered', async () => {
    const published = await createProduct('Quiet Harbor Bell');
    const draft = await createProduct('Quiet Harbor Horn', 'DRAFT');
    await converge();
    expect(await found('Quiet Harbor')).toEqual([published]);

    await send('patch', `/admin/products/${draft}`, { status: 'ACTIVE' }).expect(200);
    await converge();

    expect(await found('Quiet Harbor')).toEqual([published, draft].sort());
  });

  it('indexes a new SKU code and a new price on the product that owns them', async () => {
    const productId = await createProduct('Tidal Gauge');
    // One token sharing nothing with the name, so only the SKU field can match it.
    const skuCode = `KT${Date.now()}${seq++}`;
    const sku = await send('post', `/admin/products/${productId}/skus`, { sku: skuCode, name: 'Brass variant' }).expect(
      201,
    );
    await send('put', `/admin/skus/${(sku.body as { id: string }).id}/price`, { amountMinor: 425_000 }).expect(200);

    await converge();

    const hits = await search(skuCode);
    expect(hits.map(({ id, minPriceMinor }) => ({ id, minPriceMinor }))).toEqual([
      { id: productId, minPriceMinor: 425_000 },
    ]);
  });

  // BullMQ serves every unprioritized job first; that ordering is its contract, not re-tested here.
  it('queues a catalog event behind order and payment work', async () => {
    const productId = await createProduct('Patient Kettle');

    const job = await relayJobFor(productId);

    expect(await job.getState()).toBe('prioritized');
    expect(job.opts.priority).toBe(CATALOG_EVENT_PRIORITY);
  });
});
