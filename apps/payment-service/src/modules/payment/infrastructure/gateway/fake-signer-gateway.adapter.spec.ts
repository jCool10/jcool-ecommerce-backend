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

  describe('refunds', () => {
    async function capturedIntent() {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      const { providerSessionId } = await gateway.createSession({
        orderId: '7001',
        amountMinor: 150_000,
        currency: 'VND',
      });
      const intentId = gateway.authorize(providerSessionId);
      await gateway.captureIntent(intentId, 'capture:1:0');
      const input = { intentId, amountMinor: 150_000, currency: 'VND', orderId: '7001', requestedBy: '9001' };
      return { gateway, intentId, input };
    }

    it('refunds a captured charge once, and replays the first answer for its key', async () => {
      const { gateway, intentId, input } = await capturedIntent();

      const first = await gateway.refundIntent(input, 'refund:1:0');
      expect(first).toMatchObject({ intentId, metadataOrderId: '7001', amountMinor: 150_000, status: 'succeeded' });
      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toEqual(first);
      expect(gateway.refundsOf(intentId)).toEqual([
        expect.objectContaining({ id: first.refundId, metadata: { order_id: '7001', requested_by: '9001' } }),
      ]);
    });

    it('holds a refund as pending until settled, replaying the pending answer for its key as Stripe does', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.failRefund(intentId, 'refund_pending');

      const pending = await gateway.refundIntent(input, 'refund:1:0');
      expect(pending.status).toBe('pending');
      gateway.settleRefund(pending.refundId as string, 'succeeded');

      await expect(gateway.retrieveRefund(pending.refundId as string)).resolves.toMatchObject({ status: 'succeeded' });
      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({ status: 'pending' });
    });

    it('fails a refund with a reason, and can fail one it already reported succeeded', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.failRefund(intentId, 'refund_fails');

      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({
        status: 'failed',
        failureReason: 'expired_or_canceled_card',
      });

      const other = await capturedIntent();
      const done = await other.gateway.refundIntent(other.input, 'refund:2:0');
      other.gateway.settleRefund(done.refundId as string, 'failed');
      await expect(other.gateway.retrieveRefund(done.refundId as string)).resolves.toMatchObject({ status: 'failed' });
    });

    it('replays a stored 5xx for its key until a fresh key refunds, once', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.failRefund(intentId, 'server_error');

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(gateway.refundIntent(input, 'refund:1:0')).rejects.toMatchObject({ retryWithFreshKey: true });
      }
      await expect(gateway.refundIntent(input, 'refund:1:1')).resolves.toMatchObject({ status: 'succeeded' });
      expect(gateway.refundsOf(intentId)).toHaveLength(1);
    });

    it('answers a refund that landed before its 5xx with that refund', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.failRefund(intentId, 'refund_applied_then_500');

      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({ status: 'succeeded' });
      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({ status: 'succeeded' });
      expect(gateway.refundsOf(intentId)).toHaveLength(1);
    });

    it('applies a refund whose answer timed out, and answers the same key with it', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.failRefund(intentId, 'timeout');

      await expect(gateway.refundIntent(input, 'refund:1:0')).rejects.toMatchObject({ retryWithFreshKey: false });
      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({ status: 'succeeded' });
      expect(gateway.refundsOf(intentId)).toHaveLength(1);
    });

    it('adopts a full refund made outside the shop instead of refunding again', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      const dashboard = gateway.outOfBandRefund(intentId);

      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toMatchObject({
        refundId: dashboard,
        metadataOrderId: null,
        status: 'succeeded',
      });
      expect(gateway.refundsOf(intentId)).toHaveLength(1);
    });

    it('refuses a full refund once part of the charge was refunded elsewhere', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      gateway.outOfBandRefund(intentId, 50_000);

      await expect(gateway.refundIntent(input, 'refund:1:0')).resolves.toEqual({
        refundId: null,
        intentId,
        metadataOrderId: null,
        amountMinor: 150_000,
        currency: 'VND',
        status: 'failed',
        failureReason: 'amount_too_large',
      });
    });

    it('refuses every refund call while Stripe is unreachable, applying nothing', async () => {
      const { gateway, intentId, input } = await capturedIntent();
      const done = await gateway.refundIntent(input, 'refund:1:0');
      gateway.failRefundCalls(intentId);

      await expect(gateway.refundIntent(input, 'refund:1:1')).rejects.toThrow(/unreachable/);
      await expect(gateway.retrieveRefund(done.refundId as string)).rejects.toThrow(/unreachable/);
      gateway.restoreRefundCalls(intentId);
      await expect(gateway.retrieveRefund(done.refundId as string)).resolves.toMatchObject({ status: 'succeeded' });
    });
  });
});
