import { describe, expect, it } from 'vitest';
import { PaymentTransitionError } from './payment-state-machine';
import { PaymentStatus } from './payment-status';
import { Payment } from './payment.entity';

const AUTHORIZED_AT = new Date('2026-10-06T09:00:00Z');

function payment(status: PaymentStatus, extra: Partial<Parameters<typeof Payment.rehydrate>[0]> = {}): Payment {
  return Payment.rehydrate({
    id: '7000000000000001',
    orderId: '7000000000000002',
    provider: 'stripe',
    providerSessionId: 'cs_1',
    providerIntentId: null,
    amountMinor: 150_000,
    currency: 'VND',
    status,
    ...extra,
  });
}

describe('Payment under manual capture', () => {
  it('starts with no authorization and key generation 0', () => {
    const created = Payment.create({
      orderId: '7000000000000002',
      provider: 'stripe',
      providerSessionId: 'cs_1',
      amountMinor: 150_000,
      currency: 'vnd',
    });

    expect(created).toMatchObject({ authorizedAt: null, idempotencyKeyGen: 0 });
  });

  it('records the intent and the authorization time when the hold lands', () => {
    expect(payment(PaymentStatus.PENDING).markAuthorized('pi_1', AUTHORIZED_AT)).toMatchObject({
      status: PaymentStatus.AUTHORIZED,
      providerIntentId: 'pi_1',
      authorizedAt: AUTHORIZED_AT,
    });
  });

  it('captures only an authorized payment, keeping its authorization time', () => {
    const authorized = payment(PaymentStatus.AUTHORIZED, { providerIntentId: 'pi_1', authorizedAt: AUTHORIZED_AT });

    expect(authorized.markCaptured()).toMatchObject({ status: PaymentStatus.SUCCEEDED, authorizedAt: AUTHORIZED_AT });
    expect(() => payment(PaymentStatus.PENDING).markCaptured()).toThrow(PaymentTransitionError);
  });

  it('voids a pending or authorized payment, never a captured one', () => {
    expect(payment(PaymentStatus.PENDING).markVoided().status).toBe(PaymentStatus.VOIDED);
    expect(payment(PaymentStatus.AUTHORIZED).markVoided().status).toBe(PaymentStatus.VOIDED);
    expect(() => payment(PaymentStatus.SUCCEEDED).markVoided()).toThrow(PaymentTransitionError);
  });

  it('carries the key generation through every transition', () => {
    expect(payment(PaymentStatus.AUTHORIZED, { idempotencyKeyGen: 2 }).markVoided().idempotencyKeyGen).toBe(2);
  });
});
