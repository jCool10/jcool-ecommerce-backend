import { describe, expect, it } from 'vitest';
import { FakeSignerGatewayAdapter } from './fake-signer-gateway.adapter';

const SECRET = 'whsec_test_secret_value_0000';

describe('FakeSignerGatewayAdapter', () => {
  // Without the lowercase, every e2e probe would skip the case-folding production always goes through.
  it('reports the charge of a session it issued, lowercased as the real gateway echoes it', async () => {
    const gateway = new FakeSignerGatewayAdapter(SECRET);
    const session = await gateway.createSession({ orderId: 'o1', amountMinor: 150_000, currency: 'VND' });
    gateway.setPaymentStatus(session.providerSessionId, 'PAID');

    await expect(gateway.getPaymentStatus(session.providerSessionId)).resolves.toMatchObject({
      status: 'PAID',
      amountMinor: 150_000,
      currency: 'vnd',
    });
  });

  // A double that answered `expired` twice would let a caller mistake a redelivery for the first close.
  it('reports a second close as a no-op rather than another success', async () => {
    const gateway = new FakeSignerGatewayAdapter(SECRET);
    await gateway.expireSession('cs_open');

    await expect(gateway.expireSession('cs_open')).resolves.toBe('already_closed');
  });

  describe('retrieveSession', () => {
    it('hands back the redirect URL only while the staged status is PENDING', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      const session = await gateway.createSession({ orderId: 'o1', amountMinor: 150_000, currency: 'VND' });
      gateway.setPaymentStatus(session.providerSessionId, 'PENDING');

      await expect(gateway.retrieveSession(session.providerSessionId)).resolves.toEqual({
        status: 'PENDING',
        redirectUrl: `https://fake.gateway.test/pay/${session.providerSessionId}`,
      });

      gateway.setPaymentStatus(session.providerSessionId, 'FAILED');
      await expect(gateway.retrieveSession(session.providerSessionId)).resolves.toEqual({ status: 'FAILED' });
    });

    it('reports an unstaged handle as UNKNOWN, as a real gateway answers for one it never issued', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);

      await expect(gateway.retrieveSession('cs_never_issued')).resolves.toEqual({ status: 'UNKNOWN' });
    });
  });
});
