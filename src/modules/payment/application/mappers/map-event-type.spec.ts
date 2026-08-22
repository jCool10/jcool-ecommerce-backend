import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../domain/payment-status';
import { mapEventType } from './map-event-type';

describe('mapEventType', () => {
  it('maps the Checkout Session success event to SUCCEEDED', () => {
    expect(mapEventType('checkout.session.completed')).toBe(PaymentStatus.SUCCEEDED);
  });

  it('maps the Checkout Session expiry event to FAILED', () => {
    expect(mapEventType('checkout.session.expired')).toBe(PaymentStatus.FAILED);
  });

  it('returns null for PaymentIntent events — that flow is not the coded path and cannot resolve by session id', () => {
    expect(mapEventType('payment_intent.succeeded')).toBeNull();
    expect(mapEventType('payment_intent.payment_failed')).toBeNull();
  });

  it('returns null for events we log but do not act on', () => {
    expect(mapEventType('charge.refunded')).toBeNull();
    expect(mapEventType('invoice.paid')).toBeNull();
    expect(mapEventType('')).toBeNull();
  });
});
