import type { DrizzleTx } from '../../../database';
import type { PaymentOrderStatus } from '../domain/payment-order-status';
import { settleRefund, type RefundSettlement } from '../domain/refund-settlement';
import type { ProviderRefund } from './ports/payment-gateway.port';
import type { PaymentOrderRepositoryPort } from './ports/payment-order-repository.port';
import type { PaymentRefund, PaymentRefundRepositoryPort } from './ports/payment-refund-repository.port';

/** The command's and the webhook's one write path. Call with the header locked and the row read under it. */
export async function applyRefundSettlement(
  tx: DrizzleTx,
  repositories: { headers: PaymentOrderRepositoryPort; refunds: PaymentRefundRepositoryPort },
  header: PaymentOrderStatus,
  row: PaymentRefund,
  reported: ProviderRefund,
): Promise<RefundSettlement> {
  const settlement = settleRefund(header, row, reported);
  if (settlement.refund && !(await repositories.refunds.update(tx, row.id, settlement.refund, row.status))) {
    throw new Error(`refund row of order ${row.orderId} moved under its header lock`);
  }
  if (settlement.header) await repositories.headers.update(tx, row.orderId, { status: settlement.header });
  return settlement;
}
