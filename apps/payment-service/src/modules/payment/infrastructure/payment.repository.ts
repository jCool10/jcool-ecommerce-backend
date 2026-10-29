import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, notInArray, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx, isUniqueViolation } from '../../../database';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '../application/ports/id-generator.port';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import { PaymentOrderStatus } from '../domain/payment-order-status';
import {
  DuplicateActivePaymentError,
  type PaymentRepositoryPort,
  type UpdatePaymentStatusOptions,
} from '../application/ports/payment-repository.port';
import { paymentOrders, payments } from './schema/payment.schema';

const ACTIVE_PAYMENT_INDEX = 'uq_payments_one_active_per_order';
// Mirrors the active-payment index predicate.
const RETIRED_STATUSES = [PaymentStatus.FAILED, PaymentStatus.EXPIRED];

type PaymentRow = typeof payments.$inferSelect;

@Injectable()
export class DrizzlePaymentRepository implements PaymentRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
  ) {}

  async create(payment: Payment, tx?: DrizzleTx, mintedId?: string): Promise<Payment> {
    const executor = tx ?? this.db;
    const id = mintedId ?? (await mintOne(this.idGenerator));
    try {
      const [row] = await executor
        .insert(payments)
        .values({
          id,
          orderId: payment.orderId,
          provider: payment.provider,
          providerSessionId: payment.providerSessionId,
          providerIntentId: payment.providerIntentId,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          status: payment.status,
        })
        .returning();
      return toDomain(row);
    } catch (error) {
      // The active-payment partial-unique index lost the race — surface the invariant, not a 500.
      if (isUniqueViolation(error, ACTIVE_PAYMENT_INDEX)) {
        throw new DuplicateActivePaymentError(payment.orderId);
      }
      throw error;
    }
  }

  // Deliberately no `FOR UPDATE` even when given a tx: callers decide across a gateway round-trip,
  // and their write is a compare-and-set, so locking here would only hold the row for the trip.
  async findByOrderId(orderId: string, tx?: DrizzleTx): Promise<Payment | null> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async findByProviderSessionId(providerSessionId: string, tx?: DrizzleTx): Promise<Payment | null> {
    const executor = tx ?? this.db;
    // Session handles are generated unique per creation; order by newest as a deterministic
    // tiebreak rather than relying on a DB uniqueness that the schema doesn't declare.
    const query = executor
      .select()
      .from(payments)
      .where(eq(payments.providerSessionId, providerSessionId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
    // Inside the webhook's apply transaction, lock the row: two concurrent *distinct* events for the
    // same payment (a success and a failure, say) then serialize — the second reads the already-settled
    // status and canTransition rejects it, instead of both reading PENDING and the loser clobbering.
    const [row] = await (tx ? query.for('update') : query);
    return row ? toDomain(row) : null;
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    options: UpdatePaymentStatusOptions = {},
  ): Promise<Payment | null> {
    const executor = options.tx ?? this.db;
    const patch: { status: PaymentStatus; providerIntentId?: string | null } = { status };
    if (options.providerIntentId !== undefined) {
      patch.providerIntentId = options.providerIntentId;
    }
    // Postgres evaluates the status predicate under the row's own lock, so a caller that read the
    // row outside a transaction gets zero rows back instead of clobbering a committed change.
    const where =
      options.expectedStatus === undefined
        ? eq(payments.id, id)
        : and(eq(payments.id, id), eq(payments.status, options.expectedStatus));
    const [row] = await executor.update(payments).set(patch).where(where).returning();
    return row ? toDomain(row) : null;
  }

  async findActiveByOrderIdForUpdate(tx: DrizzleTx, orderId: string): Promise<Payment | null> {
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), notInArray(payments.status, RETIRED_STATUSES)))
      .for('update');
    return row ? toDomain(row) : null;
  }

  async findStaleTcc(options: { updatedBefore: Date; limit: number }): Promise<Payment[]> {
    const rows = await this.db
      .select({ payment: payments })
      .from(payments)
      .innerJoin(paymentOrders, eq(paymentOrders.orderId, payments.orderId))
      .where(
        and(
          lt(payments.updatedAt, options.updatedBefore),
          or(
            eq(payments.status, PaymentStatus.PENDING),
            and(
              eq(payments.status, PaymentStatus.AUTHORIZED),
              inArray(paymentOrders.status, [PaymentOrderStatus.CANCELLED, PaymentOrderStatus.FENCED]),
            ),
          ),
        ),
      )
      .orderBy(asc(payments.updatedAt), asc(payments.id))
      .limit(options.limit);
    return rows.map(({ payment }) => toDomain(payment));
  }

  async bumpUpdatedAt(id: string, expectedStatus: PaymentStatus): Promise<void> {
    await this.db
      .update(payments)
      .set({ updatedAt: new Date() })
      .where(and(eq(payments.id, id), eq(payments.status, expectedStatus)));
  }

  async incrementKeyGen(id: string, expectedGen: number): Promise<boolean> {
    const rows = await this.db
      .update(payments)
      .set({ stripeKeyGen: expectedGen + 1 })
      .where(and(eq(payments.id, id), eq(payments.stripeKeyGen, expectedGen)))
      .returning({ id: payments.id });
    return rows.length === 1;
  }
}

function toDomain(row: PaymentRow): Payment {
  return Payment.rehydrate({
    id: row.id,
    orderId: row.orderId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    providerIntentId: row.providerIntentId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    stripeKeyGen: row.stripeKeyGen,
  });
}
