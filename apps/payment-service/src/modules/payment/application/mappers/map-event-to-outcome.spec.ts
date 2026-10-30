import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../domain/payment-status';
import { mapEventToOutcome } from './map-event-to-outcome';

const SUCCEEDED = { kind: 'settle', status: PaymentStatus.SUCCEEDED };
const AWAITING = { kind: 'awaiting_payment' };

describe('mapEventToOutcome', () => {
  it('settles a completed session only once its payment_status says the money cleared', () => {
    const statuses = ['paid', 'no_payment_required', 'unpaid', undefined, ''];

    expect(statuses.map((status) => mapEventToOutcome('checkout.session.completed', status))).toEqual([
      SUCCEEDED,
      SUCCEEDED,
      AWAITING,
      AWAITING,
      AWAITING,
    ]);
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

  // PaymentIntent events cannot resolve a payment by session id, so they are not the coded path.
  it('ignores every other event, even one reporting a cleared payment', () => {
    const events = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded', 'invoice.paid', ''];

    expect(events.map((event) => mapEventToOutcome(event, 'paid'))).toEqual(events.map(() => ({ kind: 'ignore' })));
  });
});
