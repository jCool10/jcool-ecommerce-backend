import type { Payment } from '../domain/payment.entity';
import type { PaymentOrderRepositoryPort } from './ports/payment-order-repository.port';
import { PaymentGatewayError } from './ports/payment-gateway.port';
import type { PaymentRepositoryPort } from './ports/payment-repository.port';
import type { TransactionRunnerPort } from './ports/transaction-runner.port';

export const captureKey = (payment: Payment): string => `capture:${payment.id}:${payment.idempotencyKeyGen}`;

export const voidKey = (payment: Payment): string => `void:${payment.id}:${payment.idempotencyKeyGen}`;

export interface KeyRotationDeps {
  txRunner: TransactionRunnerPort;
  headers: PaymentOrderRepositoryPort;
  payments: PaymentRepositoryPort;
}

/**
 * Runs a keyed gateway call; when the gateway stored a 5xx under the current key, rotates the key and
 * rethrows. The rotation is the only write: compare-and-set on the generation the caller used, so two
 * callers that hit the same stored failure rotate it once.
 */
export async function callWithKeyRotation<T>(
  deps: KeyRotationDeps,
  payment: Payment,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PaymentGatewayError && error.retryWithFreshKey) await rotate(deps, payment);
    throw error;
  }
}

async function rotate({ txRunner, headers, payments }: KeyRotationDeps, payment: Payment): Promise<void> {
  await txRunner.run(async (tx) => {
    await headers.findForUpdate(tx, payment.orderId);
    await payments.bumpKeyGen(payment.id as string, payment.idempotencyKeyGen, tx);
  });
}
