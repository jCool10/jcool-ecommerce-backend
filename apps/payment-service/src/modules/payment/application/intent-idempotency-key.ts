import type { Payment } from '../domain/payment.entity';
import { PaymentGatewayError } from './ports/payment-gateway.port';
import type { PaymentRepositoryPort } from './ports/payment-repository.port';

/**
 * Calls Stripe under `{op}:{paymentId}:{gen}`. Stripe answers every resend of a key with the first
 * response it stored, a 5xx included, so the generation moves only when the adapter proved the call
 * did not apply. Any other failure keeps the key, and the retry stays idempotent.
 */
export async function withIntentKey<T>(
  payments: PaymentRepositoryPort,
  payment: Payment,
  op: 'capture' | 'void',
  call: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
  const id = payment.id as string;
  try {
    return await call(`${op}:${id}:${payment.stripeKeyGen}`);
  } catch (error) {
    if (error instanceof PaymentGatewayError && error.retryWithFreshKey) {
      await payments.incrementKeyGen(id, payment.stripeKeyGen);
    }
    throw error;
  }
}
