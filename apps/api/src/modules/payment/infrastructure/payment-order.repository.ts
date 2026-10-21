import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { PaymentOrderStatus } from '../domain/payment-order-status';
import type {
  PaymentOrderHeader,
  PaymentOrderRepositoryPort,
} from '../application/ports/payment-order-repository.port';
import type { PaymentParticipantStatus } from '../application/public/payment-participant.port';
import { paymentOrders, payments } from './schema/payment.schema';

interface ParticipantStatusRow extends Record<string, unknown> {
  order_id: string;
  header: PaymentOrderStatus | null;
  authorized_payment_id: string | null;
  has_authorized_attempt: boolean;
  has_succeeded_attempt: boolean;
}

const HEADER_COLUMNS = {
  orderId: paymentOrders.orderId,
  status: paymentOrders.status,
  amountMinor: paymentOrders.amountMinor,
  currency: paymentOrders.currency,
  authorizedAt: paymentOrders.authorizedAt,
};

@Injectable()
export class DrizzlePaymentOrderRepository implements PaymentOrderRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insertOpen(
    tx: DrizzleTx,
    header: { orderId: string; amountMinor: number; currency: string },
  ): Promise<boolean> {
    return this.insert(tx, { ...header, status: PaymentOrderStatus.OPEN });
  }

  async insertFenced(tx: DrizzleTx, orderId: string): Promise<boolean> {
    return this.insert(tx, { orderId, status: PaymentOrderStatus.FENCED, amountMinor: null, currency: null });
  }

  private async insert(tx: DrizzleTx, row: typeof paymentOrders.$inferInsert): Promise<boolean> {
    const inserted = await tx
      .insert(paymentOrders)
      .values(row)
      .onConflictDoNothing()
      .returning({ orderId: paymentOrders.orderId });
    return inserted.length === 1;
  }

  async findForUpdate(tx: DrizzleTx, orderId: string): Promise<PaymentOrderHeader | null> {
    const [header] = await tx
      .select(HEADER_COLUMNS)
      .from(paymentOrders)
      .where(eq(paymentOrders.orderId, orderId))
      .for('update');
    return header ?? null;
  }

  async find(orderId: string): Promise<PaymentOrderHeader | null> {
    const [header] = await this.db.select(HEADER_COLUMNS).from(paymentOrders).where(eq(paymentOrders.orderId, orderId));
    return header ?? null;
  }

  async update(
    tx: DrizzleTx,
    orderId: string,
    patch: { status?: PaymentOrderStatus; authorizedAt?: Date },
  ): Promise<void> {
    await tx.update(paymentOrders).set(patch).where(eq(paymentOrders.orderId, orderId));
  }

  async findParticipantStatuses(orderIds: string[]): Promise<Map<string, PaymentParticipantStatus>> {
    // Every lookup below goes through idx_payments_order. At most one payment is AUTHORIZED or
    // SUCCEEDED per order (the active-payment index covers both), so the scalar subquery is exact.
    const result = await this.db.execute<ParticipantStatusRow>(sql`
      select
        ids.order_id::text as order_id,
        po.status as header,
        (select p.id::text from ${payments} p
          where p.order_id = ids.order_id and p.status in ('AUTHORIZED', 'SUCCEEDED')
          limit 1) as authorized_payment_id,
        exists (select 1 from ${payments} p where p.order_id = ids.order_id and p.status = 'AUTHORIZED')
          as has_authorized_attempt,
        exists (select 1 from ${payments} p where p.order_id = ids.order_id and p.status = 'SUCCEEDED')
          as has_succeeded_attempt
      from unnest(${sql.param(orderIds)}::bigint[]) as ids(order_id)
      left join ${paymentOrders} po on po.order_id = ids.order_id`);

    return new Map(
      result.rows.map((row) => [
        row.order_id,
        {
          header: row.header,
          authorizedPaymentId: row.authorized_payment_id,
          hasAuthorizedAttempt: row.has_authorized_attempt,
          hasSucceededAttempt: row.has_succeeded_attempt,
        },
      ]),
    );
  }
}
