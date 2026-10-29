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

  describe('manual capture', () => {
    async function heldSession() {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      const { providerSessionId } = await gateway.createSession({
        orderId: 'o1',
        amountMinor: 150_000,
        currency: 'VND',
      });
      return { gateway, sessionRef: providerSessionId, intentId: gateway.authorize(providerSessionId) };
    }

    it('reports a session as open until the buyer authorizes it, then the hold it carries', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      const { providerSessionId } = await gateway.createSession({
        orderId: 'o1',
        amountMinor: 150_000,
        currency: 'VND',
      });

      await expect(gateway.retrieveAuthorization(providerSessionId)).resolves.toMatchObject({ sessionStatus: 'open' });
      const intentId = gateway.authorize(providerSessionId);
      await expect(gateway.retrieveAuthorization(providerSessionId)).resolves.toEqual({
        sessionStatus: 'complete',
        intentId,
        intentStatus: 'requires_capture',
        amountCapturableMinor: 150_000,
        currency: 'vnd',
      });
      await expect(gateway.expireSession(providerSessionId)).resolves.toBe('already_completed');
    });

    // The property key rotation exists for: resending the key only replays the stored failure.
    it('replays a stored 5xx for its key until a fresh key captures', async () => {
      const { gateway, intentId } = await heldSession();
      gateway.failCapture(intentId, 'server_error');

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(gateway.captureIntent(intentId, 'capture:1:0')).rejects.toMatchObject({ retryWithFreshKey: true });
      }
      await expect(gateway.captureIntent(intentId, 'capture:1:1')).resolves.toEqual({ kind: 'captured' });
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('answers a capture that landed before its 5xx as captured, once', async () => {
      const { gateway, intentId } = await heldSession();
      gateway.failCapture(intentId, 'applied_then_500');

      await expect(gateway.captureIntent(intentId, 'capture:1:0')).resolves.toEqual({ kind: 'captured' });
      await expect(gateway.captureIntent(intentId, 'capture:1:0')).resolves.toEqual({ kind: 'captured' });
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('voids a hold and reports a second void as already canceled', async () => {
      const { gateway, intentId } = await heldSession();

      await expect(gateway.voidIntent(intentId, 'void:1:0')).resolves.toBe('voided');
      await expect(gateway.voidIntent(intentId, 'void:1:1')).resolves.toBe('already_canceled');
      await expect(gateway.captureIntent(intentId, 'capture:1:0')).resolves.toEqual({
        kind: 'not_capturable',
        intentStatus: 'canceled',
      });
      expect(gateway.wasVoided(intentId)).toBe(true);
    });
  });
});
