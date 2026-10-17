import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { count, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductChangedHandler } from '../../src/modules/product/interface/catalog/queue/product-changed.handler';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { KafkaConsumerGroups } from '../../src/shared/messaging/kafka/kafka-consumer-groups';
import { CONSUMER_GROUPS, TOPIC_SPEC, qualifiedTopic } from '../../src/shared/messaging/kafka/kafka-topology';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { consumerLag } from '../setup/domain-event-transport';
import { createTestAppWithPool } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';

const WAIT = { timeout: 30_000, interval: 100 };
const ORDERS = 60;
const PRODUCTS = 15;

type Calls = Map<string, number>;

const bump = (calls: Calls, id: string) => calls.set(id, (calls.get(id) ?? 0) + 1);

/**
 * Counts calls through spies rather than claims: the inbox's unique key makes a second claim
 * impossible, so only the calls show whether a message reached two members.
 */
describe('Kafka consumers sharing a group (integration, real Postgres + Kafka)', () => {
  const open: INestApplication[] = [];
  let pool: Pool;
  let db: DrizzleDB;
  const prepares: Calls = new Map();
  const postCommits: Calls = new Map();
  const catalogApplies: Calls = new Map();
  const preparedBy = new Map<string, INestApplication>();

  afterEach(async () => {
    vi.restoreAllMocks();
    prepares.clear();
    postCommits.clear();
    catalogApplies.clear();
    preparedBy.clear();
    await Promise.all(open.splice(0).map((app) => app.close()));
  });

  async function boot(delayMs: (outboxId: string) => number): Promise<INestApplication> {
    let app: INestApplication;
    ({ app, pool, db } = await createTestAppWithPool({ QUEUE_WORKER_ENABLED: 'true' }));
    open.push(app);

    const dispatcher = app.get(DomainEventDispatcher);
    const prepare = dispatcher.prepare.bind(dispatcher) as DomainEventDispatcher['prepare'];
    vi.spyOn(dispatcher, 'prepare').mockImplementation(async (job) => {
      bump(prepares, job.outboxId);
      preparedBy.set(job.outboxId, app);
      await sleep(delayMs(job.outboxId));
      const step = await prepare(job);
      // Every event gets an effect after the commit, so a second run of one would show.
      return async (tx) => {
        const after = await step(tx);
        return async () => {
          bump(postCommits, job.outboxId);
          if (after) await after();
        };
      };
    });

    const handler = app.get(ProductChangedHandler);
    const apply = handler.apply.bind(handler) as ProductChangedHandler['apply'];
    vi.spyOn(handler, 'apply').mockImplementation((job) => {
      bump(catalogApplies, job.outboxId);
      return apply(job);
    });
    return app;
  }

  async function close(app: INestApplication): Promise<void> {
    open.splice(open.indexOf(app), 1);
    await app.close();
  }

  const held = (app: INestApplication) =>
    app
      .get(KafkaConsumerGroups)
      .runners.map((runner) => runner.assignment().map(({ topic, partition }) => `${topic}:${partition}`));

  const everyPartition = (app: INestApplication) => {
    const prefix = app.get(ConfigService).getOrThrow<string>('kafka.prefix');
    return Object.values(CONSUMER_GROUPS)
      .flat()
      .flatMap((topic) =>
        Array.from({ length: TOPIC_SPEC.numPartitions }, (_, p) => `${qualifiedTopic(prefix, topic)}:${p}`),
      )
      .sort();
  };

  // Each member holds partitions of both groups, and between them nothing is left unowned.
  const sharing = (one: INestApplication, two: INestApplication) =>
    vi.waitFor(() => {
      for (const app of [one, two]) expect(held(app).every((partitions) => partitions.length > 0)).toBe(true);
      expect([...held(one).flat(), ...held(two).flat()].sort()).toEqual(everyPartition(one));
    }, WAIT);

  const owningAll = (app: INestApplication) =>
    vi.waitFor(() => expect(held(app).flat().sort()).toEqual(everyPartition(app)), WAIT);

  const caughtUp = (app: INestApplication) =>
    vi.waitFor(async () => {
      expect(await consumerLag(app, 'domain-events')).toBe(0);
      expect(await consumerLag(app, 'catalog-search')).toBe(0);
    }, WAIT);

  const seed = (rows: number, eventType: string, aggregateType: string) =>
    db
      .insert(schema.outbox)
      .values(
        Array.from({ length: rows }, () => {
          const aggregateId = testId();
          return { id: testId(), aggregateType, aggregateId, eventType, payload: { orderId: aggregateId } };
        }),
      )
      .returning();

  const claims = async (consumer: string) =>
    (await db.select({ n: count() }).from(schema.inbox).where(eq(schema.inbox.consumer, consumer)))[0].n;

  const total = (calls: Calls) => [...calls.values()].reduce((sum, n) => sum + n, 0);

  it('hands every message to exactly one member while a member leaves mid-stream', async () => {
    const one = await boot(() => 25);
    const two = await boot(() => 25);
    await resetDatabase(pool);
    await sharing(one, two);

    const orders = await seed(ORDERS, 'order.placed', 'Order');
    const products = await seed(PRODUCTS, 'catalog.product.changed', 'Product');
    await expect(one.get(OutboxRelay).runOnce(ORDERS + PRODUCTS)).resolves.toEqual({
      published: ORDERS + PRODUCTS,
      failed: 0,
    });

    await vi.waitFor(() => expect(total(prepares)).toBeGreaterThanOrEqual(15), WAIT);
    expect(total(prepares)).toBeLessThan(ORDERS + PRODUCTS);
    await close(one);

    await vi.waitFor(async () => {
      expect(await claims('domain-events')).toBe(ORDERS);
      expect(await claims('catalog-search')).toBe(PRODUCTS);
    }, WAIT);
    await owningAll(two);
    await caughtUp(two);

    for (const { id } of [...orders, ...products]) {
      expect(prepares.get(id), id).toBe(1);
      expect(postCommits.get(id), id).toBe(1);
    }
    for (const { id } of products) expect(catalogApplies.get(id), id).toBe(1);
  });

  it('lets a handler finish and commit before its member leaves', async () => {
    let slowId = '';
    const one = await boot((id) => (id === slowId ? 1_500 : 0));
    const two = await boot((id) => (id === slowId ? 1_500 : 0));
    await resetDatabase(pool);
    await sharing(one, two);

    const [slow] = await seed(1, 'order.placed', 'Order');
    slowId = slow.id;
    await one.get(OutboxRelay).runOnce(10);

    // Whichever member the partition landed on is the one to close, while its handler still sleeps.
    await vi.waitFor(() => expect(preparedBy.get(slow.id)).toBeDefined(), WAIT);
    const owner = preparedBy.get(slow.id)!;
    const other = owner === one ? two : one;
    await close(owner);

    expect(postCommits.get(slow.id)).toBe(1);
    await owningAll(other);
    await caughtUp(other);
    expect(prepares.get(slow.id)).toBe(1);
    expect(postCommits.get(slow.id)).toBe(1);
  });
});
