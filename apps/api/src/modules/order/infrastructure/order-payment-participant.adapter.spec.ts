import {
  PaymentGatewayError,
  type PaymentParticipant,
} from '@modules/payment/application/public/payment-participant.port';
import type { OrderPaymentParticipantPort } from '../application/ports/order-payment-participant.port';
import { OrderPaymentParticipantAdapter } from './order-payment-participant.adapter';

describe('OrderPaymentParticipantAdapter', () => {
  const build = () => {
    const participant = {
      openSession: vi.fn<PaymentParticipant['openSession']>(),
      capture: vi.fn<PaymentParticipant['capture']>(),
      cancel: vi.fn<PaymentParticipant['cancel']>(),
      statusOf: vi.fn<PaymentParticipant['statusOf']>(),
    };
    const adapter: OrderPaymentParticipantPort = new OrderPaymentParticipantAdapter(participant);
    return { adapter, participant };
  };

  it('opens a session with the charge and deadline the caller gives', async () => {
    const { adapter, participant } = build();
    const opened = {
      outcome: 'OPENED' as const,
      paymentId: 'p-1',
      providerSessionId: 'cs_1',
      redirectUrl: 'https://x',
    };
    participant.openSession.mockResolvedValue(opened);
    const input = { orderId: 'o-1', amountMinor: 250_000, currency: 'VND', expiresAt: new Date() };

    await expect(adapter.openSession(input)).resolves.toEqual(opened);
    expect(participant.openSession).toHaveBeenCalledWith(input);
  });

  it('reports a provider refusal on open as its own error, and lets other faults through', async () => {
    const { adapter, participant } = build();
    const input = { orderId: 'o-1', amountMinor: 250_000, currency: 'VND', expiresAt: new Date() };
    const refused = new PaymentGatewayError('circuit open');
    const dbDown = new Error('db down');
    participant.openSession.mockRejectedValueOnce(refused).mockRejectedValueOnce(dbDown);

    await expect(adapter.openSession(input)).rejects.toMatchObject({
      name: 'PaymentProviderUnavailableError',
      cause: refused,
    });
    await expect(adapter.openSession(input)).rejects.toBe(dbDown);
  });

  it('captures and cancels by order id, outcomes untouched', async () => {
    const { adapter, participant } = build();
    participant.capture.mockResolvedValue('NOT_CAPTURABLE');
    participant.cancel.mockResolvedValue('CAPTURED_CONFLICT');

    await expect(adapter.capture('o-1', { signal: new AbortController().signal })).resolves.toBe('NOT_CAPTURABLE');
    await expect(adapter.cancel('o-1')).resolves.toBe('CAPTURED_CONFLICT');
    expect(participant.capture).toHaveBeenCalledWith({ orderId: 'o-1' });
    expect(participant.cancel).toHaveBeenCalledWith({ orderId: 'o-1' });
  });

  it('forwards statusOf for the whole batch', async () => {
    const { adapter, participant } = build();
    const statuses = new Map([
      [
        'o-1',
        {
          header: 'AUTHORIZED' as const,
          authorizedPaymentId: 'p-1',
          hasAuthorizedAttempt: true,
          hasSucceededAttempt: false,
        },
      ],
    ]);
    participant.statusOf.mockResolvedValue(statuses);

    await expect(adapter.statusOf(['o-1'])).resolves.toEqual(statuses);
    expect(participant.statusOf).toHaveBeenCalledWith(['o-1']);
  });
});
