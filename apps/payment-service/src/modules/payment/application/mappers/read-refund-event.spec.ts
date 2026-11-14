import { describe, expect, it } from 'vitest';
import { REFUND_EVENT_TYPES, readRefundEvent } from './read-refund-event';

describe('readRefundEvent', () => {
  it('reads the refund id and nothing else from the body', () => {
    expect(
      readRefundEvent({ data: { object: { id: 're_1', status: 'succeeded', metadata: { order_id: '7' } } } }),
    ).toEqual({ refundId: 're_1' });
  });

  it.each([undefined, null, {}, { data: {} }, { data: { object: { id: 7 } } }, { data: { object: { id: 'ch_1' } } }])(
    'reads no refund id from %j',
    (payload) => {
      expect(readRefundEvent(payload)).toEqual({});
    },
  );

  it('routes the three refund events and leaves charge.refunded alone', () => {
    expect([...REFUND_EVENT_TYPES]).toEqual(['refund.created', 'refund.updated', 'refund.failed']);
    expect(REFUND_EVENT_TYPES.has('charge.refunded')).toBe(false);
  });
});
