import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { CheckoutSagaStep, TERMINAL_SAGA_STEPS, type Compensation } from '../domain/checkout-saga-step';
import type {
  CheckoutSaga,
  CheckoutSagaRepositoryPort,
  CheckoutSagaUpdate,
} from '../application/ports/checkout-saga-repository.port';
import { checkoutSagas } from './schema/checkout-saga.schema';

type SagaRow = typeof checkoutSagas.$inferSelect;

const notTerminal = notInArray(checkoutSagas.step, [...TERMINAL_SAGA_STEPS]);
const leaseFree = or(isNull(checkoutSagas.leaseUntil), lt(checkoutSagas.leaseUntil, sql`now()`));
const bumpVersion = sql`${checkoutSagas.version} + 1`;

// One expression for both columns: `now()` is fixed for the statement, so they come out equal.
const leaseEnd = (leaseMs: number) => sql`now() + ${leaseMs} * interval '1 millisecond'`;

@Injectable()
export class DrizzleCheckoutSagaRepository implements CheckoutSagaRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insertLeased(
    tx: DrizzleTx,
    { orderId, deadlineAt, leaseMs }: { orderId: string; deadlineAt: Date; leaseMs: number },
  ): Promise<CheckoutSaga> {
    const [row] = await tx
      .insert(checkoutSagas)
      .values({
        orderId,
        step: CheckoutSagaStep.RESERVING,
        deadlineAt,
        leaseUntil: leaseEnd(leaseMs),
        nextAttemptAt: leaseEnd(leaseMs),
      })
      .returning();
    return toSaga(row);
  }

  async claim(orderId: string, leaseMs: number): Promise<CheckoutSaga | null> {
    const [row] = await this.db
      .update(checkoutSagas)
      .set({ leaseUntil: leaseEnd(leaseMs), nextAttemptAt: leaseEnd(leaseMs), version: bumpVersion })
      .where(and(eq(checkoutSagas.orderId, orderId), notTerminal, leaseFree))
      .returning();
    return row ? toSaga(row) : null;
  }

  async renew(orderId: string, version: number, leaseMs: number): Promise<number | null> {
    const [row] = await this.db
      .update(checkoutSagas)
      .set({ leaseUntil: leaseEnd(leaseMs), nextAttemptAt: leaseEnd(leaseMs), version: bumpVersion })
      .where(and(eq(checkoutSagas.orderId, orderId), eq(checkoutSagas.version, version)))
      .returning({ version: checkoutSagas.version });
    return row?.version ?? null;
  }

  async applyLeased(tx: DrizzleTx, orderId: string, version: number, update: CheckoutSagaUpdate): Promise<boolean> {
    const rows = await tx
      .update(checkoutSagas)
      .set({ ...toColumns(update), leaseUntil: null, version: bumpVersion })
      .where(and(eq(checkoutSagas.orderId, orderId), eq(checkoutSagas.version, version)))
      .returning({ orderId: checkoutSagas.orderId });
    return rows.length > 0;
  }

  async rewrite(tx: DrizzleTx, orderId: string, update: CheckoutSagaUpdate): Promise<void> {
    await tx
      .update(checkoutSagas)
      .set({ ...toColumns(update), version: bumpVersion })
      .where(eq(checkoutSagas.orderId, orderId));
  }

  async findForUpdate(tx: DrizzleTx, orderId: string): Promise<CheckoutSaga | null> {
    const [row] = await tx.select().from(checkoutSagas).where(eq(checkoutSagas.orderId, orderId)).for('update');
    return row ? toSaga(row) : null;
  }

  async findByOrderId(orderId: string): Promise<CheckoutSaga | null> {
    const [row] = await this.db.select().from(checkoutSagas).where(eq(checkoutSagas.orderId, orderId));
    return row ? toSaga(row) : null;
  }

  async findDue(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ orderId: checkoutSagas.orderId })
      .from(checkoutSagas)
      .where(and(notTerminal, lte(checkoutSagas.nextAttemptAt, sql`now()`), leaseFree))
      .orderBy(asc(checkoutSagas.nextAttemptAt))
      .limit(limit);
    return rows.map((row) => row.orderId);
  }
}

function toColumns(update: CheckoutSagaUpdate) {
  return {
    step: update.step,
    pendingCompensations: [...update.pendingCompensations],
    nextAttemptAt: update.nextAttemptAt,
    attempts: update.attempts,
    lastError: update.lastError,
  };
}

function toSaga(row: SagaRow): CheckoutSaga {
  return {
    orderId: row.orderId,
    step: row.step,
    pendingCompensations: row.pendingCompensations as Compensation[],
    deadlineAt: row.deadlineAt,
    nextAttemptAt: row.nextAttemptAt,
    attempts: row.attempts,
    leaseUntil: row.leaseUntil,
    lastError: row.lastError,
    version: row.version,
  };
}
