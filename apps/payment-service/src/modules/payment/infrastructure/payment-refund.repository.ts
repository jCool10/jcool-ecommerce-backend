import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '../../../database';
import type { PaymentRefundStatus } from '../domain/payment-refund-status';
import type {
  NewPaymentRefund,
  PaymentRefund,
  PaymentRefundPatch,
  PaymentRefundRepositoryPort,
} from '../application/ports/payment-refund-repository.port';
import { paymentRefunds } from './schema/payment.schema';

const COLUMNS = {
  id: paymentRefunds.id,
  orderId: paymentRefunds.orderId,
  paymentId: paymentRefunds.paymentId,
  providerRefundId: paymentRefunds.providerRefundId,
  coveredRefundIds: paymentRefunds.coveredRefundIds,
  requestedBy: paymentRefunds.requestedBy,
  amountMinor: paymentRefunds.amountMinor,
  currency: paymentRefunds.currency,
  status: paymentRefunds.status,
  failureReason: paymentRefunds.failureReason,
};

@Injectable()
export class DrizzlePaymentRefundRepository implements PaymentRefundRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insert(tx: DrizzleTx, refund: NewPaymentRefund): Promise<boolean> {
    const inserted = await tx
      .insert(paymentRefunds)
      .values(refund)
      .onConflictDoNothing({ target: paymentRefunds.orderId })
      .returning({ id: paymentRefunds.id });
    return inserted.length === 1;
  }

  async findByOrderId(orderId: string, tx?: DrizzleTx): Promise<PaymentRefund | null> {
    const [row] = await (tx ?? this.db).select(COLUMNS).from(paymentRefunds).where(eq(paymentRefunds.orderId, orderId));
    return row ?? null;
  }

  async findByProviderRefundId(providerRefundId: string, tx?: DrizzleTx): Promise<PaymentRefund | null> {
    const [row] = await (tx ?? this.db)
      .select(COLUMNS)
      .from(paymentRefunds)
      .where(eq(paymentRefunds.providerRefundId, providerRefundId));
    return row ?? null;
  }

  async update(
    tx: DrizzleTx,
    id: string,
    patch: PaymentRefundPatch,
    expectedStatus: PaymentRefundStatus,
  ): Promise<boolean> {
    const updated = await tx
      .update(paymentRefunds)
      .set(patch)
      .where(and(eq(paymentRefunds.id, id), eq(paymentRefunds.status, expectedStatus)))
      .returning({ id: paymentRefunds.id });
    return updated.length === 1;
  }
}
