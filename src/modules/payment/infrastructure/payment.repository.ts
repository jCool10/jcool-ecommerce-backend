import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import type { PaymentRepositoryPort, UpdatePaymentStatusOptions } from '../application/ports/payment-repository.port';
import { payments } from './schema/payment.schema';

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
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
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
    const [row] = await executor.update(payments).set(patch).where(eq(payments.id, id)).returning();
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
