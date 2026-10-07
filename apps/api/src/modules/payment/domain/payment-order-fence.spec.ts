import { describe, expect, it } from 'vitest';
import { cancelAction, captureAction, headerAfterAuthorization, openSessionAction } from './payment-order-fence';
import { PAYMENT_ORDER_STATUSES, type PaymentOrderStatus } from './payment-order-status';

const TABLE: Array<
  [
    PaymentOrderStatus | null,
    {
      openSession: ReturnType<typeof openSessionAction>;
      capture: ReturnType<typeof captureAction>;
      cancel: ReturnType<typeof cancelAction>;
    },
  ]
> = [
  [null, { openSession: 'create', capture: 'not_capturable', cancel: 'fence' }],
  ['OPEN', { openSession: 'open', capture: 'not_capturable', cancel: 'cancel' }],
  ['AUTHORIZED', { openSession: 'closed', capture: 'capture', cancel: 'cancel' }],
  ['CAPTURED', { openSession: 'closed', capture: 'captured', cancel: 'captured_conflict' }],
  ['CANCELLED', { openSession: 'closed', capture: 'not_capturable', cancel: 'sweep' }],
  ['FENCED', { openSession: 'closed', capture: 'not_capturable', cancel: 'sweep' }],
];

describe('payment order fence', () => {
  it.each(TABLE)('on %s', (status, expected) => {
    expect({
      openSession: openSessionAction(status),
      capture: captureAction(status),
      cancel: cancelAction(status),
    }).toEqual(expected);
  });

  it('covers every status the header can hold', () => {
    expect(TABLE.map(([status]) => status)).toEqual([null, ...PAYMENT_ORDER_STATUSES]);
  });

  it('moves only an OPEN header on authorization, so a late one cannot reopen a closed order', () => {
    expect(PAYMENT_ORDER_STATUSES.map((status) => [status, headerAfterAuthorization(status)])).toEqual([
      ['OPEN', 'AUTHORIZED'],
      ['AUTHORIZED', 'AUTHORIZED'],
      ['CAPTURED', 'CAPTURED'],
      ['CANCELLED', 'CANCELLED'],
      ['FENCED', 'FENCED'],
    ]);
  });
});
