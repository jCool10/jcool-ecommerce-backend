import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database';
import { Payment } from '../domain/payment.entity';
import { DuplicateActivePaymentError } from '../application/ports/payment-repository.port';
import { DrizzlePaymentRepository } from './payment.repository';

// The partial-unique index is the only race-safe guard against charging one order twice, and the
// pg error reaches `create` wrapped by Drizzle's statement builder — so the shape fed in here is the
// wrapper, not a bare driver error.
function repositoryRejectingWith(error: Error): DrizzlePaymentRepository {
  const db = {
    insert: () => ({ values: () => ({ returning: () => Promise.reject(error) }) }),
  } as unknown as DrizzleDB;
  return new DrizzlePaymentRepository(db);
}

function wrapped(constraint: string): DrizzleQueryError {
  const driverError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
  return new DrizzleQueryError('insert into "payments" ... returning *', [], driverError);
}

function newPayment(): Payment {
  return Payment.create({
    orderId: 'order-1',
    provider: 'stripe',
    providerSessionId: 'cs_test_1',
    amountMinor: 1000,
    currency: 'USD',
  });
}

describe('DrizzlePaymentRepository', () => {
  describe('create', () => {
    it('translates a wrapped one-active-per-order unique violation into DuplicateActivePaymentError', async () => {
      const repository = repositoryRejectingWith(wrapped('uq_payments_one_active_per_order'));

      await expect(repository.create(newPayment())).rejects.toBeInstanceOf(DuplicateActivePaymentError);
    });

    it('rethrows a unique violation on a different index instead of reporting a duplicate payment', async () => {
      const error = wrapped('uq_payments_something_else');
      const repository = repositoryRejectingWith(error);

      await expect(repository.create(newPayment())).rejects.toBe(error);
    });
  });
});
