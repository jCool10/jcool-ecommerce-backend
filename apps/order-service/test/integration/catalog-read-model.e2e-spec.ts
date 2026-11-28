import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  type CatalogSkuSnapshotPayload,
  type CatalogSkuSnapshotSku,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import {
  ORDER_EVENTS_CONSUMER,
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  orderEventsJobOptions,
} from '@jcool/internal-contracts/queues/order-events';
import { type DeadLetterJob, type DomainEventJob, DomainEventProcessor, jobIdFor, queueToken } from '@jcool/messaging';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import {
  CATALOG_SKU_QUERY,
  type CatalogSkuQueryPort,
} from '../../src/modules/catalog/application/public/catalog-sku-query.port';
import {
  closeAppAfterAll,
  createTestAppWithPool,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';

// The shipped ladder the api stamps on every snapshot; a refused one must not climb it.
const LONG_LADDER_ATTEMPTS = 15;

describe('Catalog SKU read model (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let processor: DomainEventProcessor;
  let query: CatalogSkuQueryPort;
  let queue: Queue;
  let dlq: Queue;

  const productId = testId();
  const skuA = testId();
  const skuB = testId();

  const sku = (skuId: string, unitPriceMinor: number | null = 249_000, isActive = true): CatalogSkuSnapshotSku => ({
    skuId,
    unitPriceMinor,
    currency: 'VND',
    isActive,
  });

  const snapshot = (version: number, skus: CatalogSkuSnapshotSku[]): CatalogSkuSnapshotPayload => ({
    productId,
    version,
    productName: `Linen shirt v${version}`,
    skus,
  });

  const snapshotJob = (payload: object, overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
    outboxId: testId(),
    aggregateType: 'Product',
    aggregateId: productId,
    eventType: CATALOG_SKU_SNAPSHOT_EVENT,
    payload: payload as Record<string, unknown>,
    occurredAt: new Date().toISOString(),
    traceparent: null,
    ...overrides,
  });

  const deliver = (payload: object, overrides: Partial<DomainEventJob> = {}) =>
    processor.process(snapshotJob(payload, overrides), ORDER_EVENTS_QUEUE);

  const storedRows = () =>
    db
      .select({
        skuId: schema.catalogSkuViews.skuId,
        productId: schema.catalogSkuViews.productId,
        productName: schema.catalogSkuViews.productName,
        unitPriceMinor: schema.catalogSkuViews.unitPriceMinor,
        currency: schema.catalogSkuViews.currency,
        isActive: schema.catalogSkuViews.isActive,
        productVersion: schema.catalogSkuViews.productVersion,
      })
      .from(schema.catalogSkuViews)
      .orderBy(asc(schema.catalogSkuViews.skuId));

  const stored = (version: number, ...skus: CatalogSkuSnapshotSku[]) =>
    skus.map(({ skuId, unitPriceMinor, currency, isActive }) => ({
      skuId,
      productId,
      productName: `Linen shirt v${version}`,
      unitPriceMinor,
      currency,
      isActive,
      productVersion: version,
    }));

  const claimed = async (messageId: string): Promise<boolean> => {
    const rows = await db
      .select({ messageId: schema.inbox.messageId })
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, ORDER_EVENTS_CONSUMER), eq(schema.inbox.messageId, messageId)));
    return rows.length === 1;
  };

  // As the api's relay adds it: keyed by the outbox id, on the ladder the producer stamps.
  const publish = async (job: DomainEventJob): Promise<void> => {
    await queue.add(job.eventType, job, {
      jobId: jobIdFor(job.outboxId),
      ...orderEventsJobOptions(job.eventType, LONG_LADDER_ATTEMPTS),
    });
  };

  const waitForClaim = (messageId: string) =>
    vi.waitFor(async () => expect(await claimed(messageId)).toBe(true), { timeout: 15_000, interval: 50 });

  const waitForDeadLetter = async (): Promise<Job<DeadLetterJob>> => {
    let jobs: Job<DeadLetterJob>[] = [];
    await vi.waitFor(
      async () => {
        jobs = (await dlq.getJobs(['waiting', 'prioritized'])) as Job<DeadLetterJob>[];
        expect(jobs).toHaveLength(1);
      },
      { timeout: 15_000, interval: 50 },
    );
    return jobs[0];
  };

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ QUEUE_WORKER_ENABLED: 'true' }));
    processor = app.get(DomainEventProcessor);
    query = app.get<CatalogSkuQueryPort>(CATALOG_SKU_QUERY);
    queue = app.get<Queue>(queueToken(ORDER_EVENTS_QUEUE));
    dlq = app.get<Queue>(queueToken(ORDER_EVENTS_DLQ));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [queue, dlq]);

  it('stores one row per SKU at the product version, an unpriced SKU as null', async () => {
    await expect(deliver(snapshot(1, [sku(skuA), sku(skuB, null)]))).resolves.toBe('processed');

    expect(await storedRows()).toEqual(stored(1, sku(skuA), sku(skuB, null)));
  });

  it('refuses an older or an equal version and keeps the newer row', async () => {
    await deliver(snapshot(3, [sku(skuA, 300_000)]));

    await expect(deliver(snapshot(2, [sku(skuA, 200_000)]))).resolves.toBe('processed');
    await expect(deliver(snapshot(3, [sku(skuA, 333_000)]))).resolves.toBe('processed');

    expect(await storedRows()).toEqual(stored(3, sku(skuA, 300_000)));
  });

  it('applies a redelivered snapshot once', async () => {
    const outboxId = testId();

    await expect(deliver(snapshot(1, [sku(skuA)]), { outboxId })).resolves.toBe('processed');
    await expect(deliver(snapshot(1, [sku(skuA)]), { outboxId })).resolves.toBe('duplicate');

    expect(await storedRows()).toEqual(stored(1, sku(skuA)));
    expect(await db.select().from(schema.inbox)).toHaveLength(1);
  });

  it('inserts a SKU a later snapshot adds', async () => {
    await deliver(snapshot(1, [sku(skuA)]));

    await deliver(snapshot(2, [sku(skuA), sku(skuB, 99_000)]));

    expect(await storedRows()).toEqual(stored(2, sku(skuA), sku(skuB, 99_000)));
  });

  it('keeps the price of a SKU that turned inactive', async () => {
    await deliver(snapshot(1, [sku(skuA, 249_000)]));

    await deliver(snapshot(2, [sku(skuA, 249_000, false)]));

    expect(await storedRows()).toEqual(stored(2, sku(skuA, 249_000, false)));
  });

  it('claims a snapshot of a product without SKUs and writes no row', async () => {
    const outboxId = testId();

    await expect(deliver(snapshot(0, []), { outboxId })).resolves.toBe('processed');

    expect(await storedRows()).toEqual([]);
    expect(await claimed(outboxId)).toBe(true);
  });

  it('answers the read port with what was applied, leaving out ids it does not hold', async () => {
    const unknown = testId();
    await deliver(snapshot(1, [sku(skuA), sku(skuB, null, false)]));

    const views = await query.getSkuViews([skuB, unknown, skuA, 'not-an-id']);

    expect(views).toHaveLength(2);
    expect(views).toEqual(
      expect.arrayContaining([
        { skuId: skuA, productName: 'Linen shirt v1', unitPriceMinor: 249_000, currency: 'VND', isActive: true },
        { skuId: skuB, productName: 'Linen shirt v1', unitPriceMinor: null, currency: 'VND', isActive: false },
      ]),
    );
    await expect(query.getSkuView(skuA)).resolves.toEqual(views.find((view) => view.skuId === skuA));
    await expect(query.getSkuView(unknown)).resolves.toBeNull();
    await expect(query.getSkuViews([])).resolves.toEqual([]);
  });

  it('keeps v2 when the queue delivers v2 before v1', async () => {
    const v2 = snapshotJob(snapshot(2, [sku(skuA, 220_000)]));
    const v1 = snapshotJob(snapshot(1, [sku(skuA, 110_000)]));

    await publish(v2);
    await waitForClaim(v2.outboxId);
    await publish(v1);
    await waitForClaim(v1.outboxId);

    expect(await storedRows()).toEqual(stored(2, sku(skuA, 220_000)));
  });

  it.each([
    ['a USD line', (version: number) => snapshot(version, [{ ...sku(skuA), currency: 'USD' }]), {}],
    ['a zero price', (version: number) => snapshot(version, [sku(skuA, 0)]), {}],
    ['a version past the ceiling', () => snapshot(2_147_483_648, [sku(skuA, 1)]), {}],
    [
      'another product as its aggregate',
      (version: number) => snapshot(version, [sku(skuA, 1)]),
      { aggregateId: testId() },
    ],
  ])(
    'dead-letters a snapshot with %s after one attempt and leaves the stored rows alone',
    async (_case, payloadAt, overrides) => {
      await deliver(snapshot(1, [sku(skuA)]));
      const refused = snapshotJob(payloadAt(2), overrides);

      await publish(refused);
      const dead = await waitForDeadLetter();

      expect(dead.id).toBe(jobIdFor(refused.outboxId));
      expect(dead.data.attemptsMade).toBe(1);
      expect(await storedRows()).toEqual(stored(1, sku(skuA)));
      expect(await claimed(refused.outboxId)).toBe(false);
    },
  );
});
