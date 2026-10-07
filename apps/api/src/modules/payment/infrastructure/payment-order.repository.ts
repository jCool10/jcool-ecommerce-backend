import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import type {
  PaymentOrderHeader,
  PaymentOrderRepositoryPort,
} from '../application/ports/payment-order-repository.port';
import type { PaymentOrderStatus } from '../domain/payment-order-status';
import { paymentOrders } from './schema/payment.schema';

const HEADER = {
  orderId: paymentOrders.orderId,
  status: paymentOrders.status,
  amountMinor: paymentOrders.amountMinor,
  currency: paymentOrders.currency,
};

@Injectable()
export class DrizzlePaymentOrderRepository implements PaymentOrderRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insertIfAbsent(tx: DrizzleTx, header: PaymentOrderHeader): Promise<boolean> {
    const inserted = await tx
      .insert(paymentOrders)
      .values(header)
      .onConflictDoNothing({ target: paymentOrders.orderId })
      .returning({ orderId: paymentOrders.orderId });
    return inserted.length === 1;
  }

  async findForUpdate(tx: DrizzleTx, orderId: string): Promise<PaymentOrderHeader | null> {
    const [row] = await tx.select(HEADER).from(paymentOrders).where(eq(paymentOrders.orderId, orderId)).for('update');
    return row ?? null;
  }

  async find(orderId: string): Promise<PaymentOrderHeader | null> {
    const [row] = await this.db.select(HEADER).from(paymentOrders).where(eq(paymentOrders.orderId, orderId));
    return row ?? null;
  }

  async updateStatus(
    tx: DrizzleTx,
    orderId: string,
    status: PaymentOrderStatus,
    expected: PaymentOrderStatus,
  ): Promise<boolean> {
    const updated = await tx
      .update(paymentOrders)
      .set({ status })
      .where(and(eq(paymentOrders.orderId, orderId), eq(paymentOrders.status, expected)))
      .returning({ orderId: paymentOrders.orderId });
    return updated.length === 1;
  }
}
