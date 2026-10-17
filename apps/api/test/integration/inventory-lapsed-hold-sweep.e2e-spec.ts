import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '../../src/modules/product/application/public/inventory-participant.port';
import {
  STOCK_REPOSITORY,
  type StockRepositoryPort,
} from '../../src/modules/product/application/stock/ports/stock-repository.port';
import { ReleaseLapsedHoldsUseCase } from '../../src/modules/product/application/stock/release-lapsed-holds.use-case';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { lapseHoldHeader, readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import { lapseReservation, readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';

describe('Inventory lapsed hold sweep (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let participant: InventoryParticipant;
  let sweep: ReleaseLapsedHoldsUseCase;
  let sku: string;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ METRICS_TOKEN: E2E_METRICS_TOKEN }));
    participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    sweep = app.get(ReleaseLapsedHoldsUseCase);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = testId();
    await seedStock(app, sku, 10);
  });

  async function holdThroughParticipant(quantity = 3): Promise<string> {
    const orderId = testId();
    await participant.tryReserve({
      orderId,
      lines: [{ variantId: sku, quantity }],
      holdUntil: new Date(Date.now() + 60 * 60_000),
    });
    return orderId;
  }

  it('releases only the participant holds whose hold_until has passed', async () => {
    const lapsed = await holdThroughParticipant(3);
    const live = await holdThroughParticipant(2);
    await lapseHoldHeader(app, lapsed);

    await expect(sweep.execute({ batchSize: 50 })).resolves.toEqual({
      scanned: 1,
      released: 1,
      raced: 0,
      errors: 0,
    });

    expect(await readReservationOrder(app, lapsed)).toMatchObject({ status: 'RELEASED' });
    expect(await readReservationOrder(app, live)).toMatchObject({ status: 'HELD' });
    expect((await readStock(app, sku)).quantityReserved).toBe(2);
  });

  it('leaves a lapsed hold placed by the current checkout to the order module', async () => {
    const repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
    const orderId = testId();
    await db.transaction((tx) => repo.reservePessimistic(tx, orderId, [{ variantId: sku, quantity: 3 }]));
    await lapseReservation(app, orderId);

    await expect(sweep.execute({ batchSize: 50 })).resolves.toMatchObject({ scanned: 0 });

    const [reservation] = await reservationsFor(app, orderId);
    expect(reservation.status).toBe('HELD');
    expect((await readStock(app, sku)).quantityReserved).toBe(3);
  });

  it('refuses to commit a hold the sweep already released', async () => {
    const orderId = await holdThroughParticipant();
    await lapseHoldHeader(app, orderId);
    await sweep.execute({ batchSize: 50 });

    await expect(participant.commit(orderId)).resolves.toEqual({ outcome: 'CONFLICT' });

    expect(await readStock(app, sku)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it('counts the Try and the sweep under the inventory participant', async () => {
    const orderId = await holdThroughParticipant();
    await lapseHoldHeader(app, orderId);
    await sweep.execute({ batchSize: 50 });

    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(text).toMatch(/^tcc_branch_total\{participant="inventory",op="try",outcome="ok"\} [1-9]\d*$/m);
    expect(text).toMatch(/^tcc_branch_total\{participant="inventory",op="sweep",outcome="ok"\} [1-9]\d*$/m);
  });
});
