import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../domain/payment-status';
import { mapEventToOutcome } from './map-event-to-outcome';

describe('mapEventToOutcome', () => {
  it('settles a completed Checkout Session as SUCCEEDED once the money has cleared', () => {
    expect(mapEventToOutcome('checkout.session.completed', 'paid')).toEqual({
      kind: 'settle',
      status: PaymentStatus.SUCCEEDED,
    });
  });

  it('settles a fully-discounted session as SUCCEEDED — there is nothing left to capture', () => {
    expect(mapEventToOutcome('checkout.session.completed', 'no_payment_required')).toEqual({
      kind: 'settle',
      status: PaymentStatus.SUCCEEDED,
    });
  });

  it('refuses to settle a completed session whose payment has not cleared', () => {
    expect(mapEventToOutcome('checkout.session.completed', 'unpaid')).toEqual({ kind: 'awaiting_payment' });
  });

  it('refuses to settle a completed session that reports no payment_status at all', () => {
    expect(mapEventToOutcome('checkout.session.completed', undefined)).toEqual({ kind: 'awaiting_payment' });
    expect(mapEventToOutcome('checkout.session.completed', '')).toEqual({ kind: 'awaiting_payment' });
  });

  it('maps the Checkout Session expiry event to FAILED regardless of payment_status', () => {
    expect(mapEventToOutcome('checkout.session.expired', undefined)).toEqual({
      kind: 'settle',
      status: PaymentStatus.FAILED,
    });
    expect(mapEventToOutcome('checkout.session.expired', 'unpaid')).toEqual({
      kind: 'settle',
      status: PaymentStatus.FAILED,
    });
  });

  it('ignores PaymentIntent events — that flow is not the coded path and cannot resolve by session id', () => {
    expect(mapEventToOutcome('payment_intent.succeeded', 'paid')).toEqual({ kind: 'ignore' });
    expect(mapEventToOutcome('payment_intent.payment_failed', undefined)).toEqual({ kind: 'ignore' });
  });

  it('ignores events we log but do not act on, even when they report a cleared payment', () => {
    expect(mapEventToOutcome('charge.refunded', 'paid')).toEqual({ kind: 'ignore' });
    expect(mapEventToOutcome('invoice.paid', 'paid')).toEqual({ kind: 'ignore' });
    expect(mapEventToOutcome('', 'paid')).toEqual({ kind: 'ignore' });
  });
});
