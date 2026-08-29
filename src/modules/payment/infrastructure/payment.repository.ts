import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx, isUniqueViolation } from '@shared/infrastructure/database';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import {
  DuplicateActivePaymentError,
  type PaymentRepositoryPort,
  type UpdatePaymentStatusOptions,
} from '../application/ports/payment-repository.port';
import { payments } from './schema/payment.schema';

const ACTIVE_PAYMENT_INDEX = 'uq_payments_one_active_per_order';

type PaymentRow = typeof payments.$inferSelect;

/**
 * Drizzle adapter for PaymentRepositoryPort. `create` and `updateStatus` accept an
 * optional `tx` so a payment write can commit inside the caller's transaction (e.g. the
 * webhook handler applying a status change alongside the event log); without one they run
 * on the pooled connection.
 */
@Injectable()
export class DrizzlePaymentRepository implements PaymentRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(payment: Payment, tx?: DrizzleTx): Promise<Payment> {
    const executor = tx ?? this.db;
    try {
      const [row] = await executor
        .insert(payments)
        .values({
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
    // Inside the webhook's apply transaction, lock the row (FOR UPDATE): two concurrent *distinct*
    // events for the same payment (e.g. a success and a failure) then serialize — the second reads
    // the already-settled status and the domain's canTransition guard rejects it, instead of both
    // reading PENDING and the loser clobbering the winner.
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
  });
}
