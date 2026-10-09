import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from './fake-signer-gateway.adapter';

const SECRET = 'whsec_test_secret_value_0000';
const DEADLINE = new Date('2026-10-06T11:00:00Z');

async function authorizedHold(gateway = new FakeSignerGatewayAdapter(SECRET)) {
  const { providerSessionId } = await gateway.createSession({
    orderId: 'o1',
    amountMinor: 150_000,
    currency: 'VND',
    captureMethod: 'manual',
    expiresAt: DEADLINE,
  });
  return { gateway, sessionRef: providerSessionId, intentId: gateway.authorize(providerSessionId) };
}

const rejection = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: unknown) => e as PaymentGatewayError,
  );

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
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps what the caller asked for and serves a manual session as open until the buyer pays', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      const { providerSessionId } = await gateway.createSession({
        orderId: 'o1',
        amountMinor: 150_000,
        currency: 'VND',
        captureMethod: 'manual',
        expiresAt: DEADLINE,
      });

      expect(gateway.sessionRequest(providerSessionId)).toMatchObject({ captureMethod: 'manual', expiresAt: DEADLINE });
      await expect(gateway.retrieveAuthorization(providerSessionId)).resolves.toEqual({ sessionStatus: 'open' });
      await expect(gateway.retrieveSession(providerSessionId)).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('reports the hold an authorized session carries, and nothing for a session it cannot read', async () => {
      const { gateway, sessionRef, intentId } = await authorizedHold();

      await expect(gateway.retrieveAuthorization(sessionRef)).resolves.toEqual({
        sessionStatus: 'complete',
        intentId,
        intentStatus: 'requires_capture',
        amountCapturableMinor: 150_000,
        currency: 'vnd',
      });
      await expect(gateway.retrieveSession(sessionRef)).resolves.toEqual({ status: 'PENDING' });
      await expect(gateway.expireSession(sessionRef)).resolves.toBe('already_completed');
      await expect(gateway.retrieveAuthorization('cs_never_issued')).resolves.toEqual({ sessionStatus: 'unknown' });
    });

    it('captures a hold once, replaying the stored result for a resent key', async () => {
      const { gateway, intentId } = await authorizedHold();

      await expect(gateway.capture(intentId, 'capture:p1:0')).resolves.toEqual({ kind: 'captured' });
      await expect(gateway.capture(intentId, 'capture:p1:0')).resolves.toEqual({ kind: 'captured' });
      await expect(gateway.capture(intentId, 'capture:p1:1')).resolves.toEqual({ kind: 'captured' });

      expect(gateway.captureCalls(intentId)).toBe(1);
      expect(gateway.requestKeys(intentId)).toEqual(['capture:p1:0', 'capture:p1:0', 'capture:p1:1']);
    });

    // As Stripe does: the 500 is stored against the key, so only a fresh key reaches the hold.
    it('replays a stored 500 for its key while the hold stays capturable', async () => {
      const { gateway, intentId } = await authorizedHold();
      gateway.failCapture(intentId, 'server_error');

      const first = await rejection(gateway.capture(intentId, 'capture:p1:0'));
      const resent = await rejection(gateway.capture(intentId, 'capture:p1:0'));

      expect([first?.retryWithFreshKey, resent?.retryWithFreshKey]).toEqual([true, true]);
      await expect(gateway.capture(intentId, 'capture:p1:1')).resolves.toEqual({ kind: 'captured' });
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('reports a capture that landed before its 500 as captured, without a second capture', async () => {
      const { gateway, intentId } = await authorizedHold();
      gateway.failCapture(intentId, 'applied_then_500');

      await expect(gateway.capture(intentId, 'capture:p1:0')).resolves.toEqual({ kind: 'captured' });
      expect(gateway.captureCalls(intentId)).toBe(1);
    });

    it('stores nothing for a timeout or an in-flight key, so the same key succeeds next time', async () => {
      for (const mode of ['timeout', 'idempotency_in_flight'] as const) {
        const { gateway, intentId } = await authorizedHold();
        gateway.failCapture(intentId, mode);

        const error = await rejection(gateway.capture(intentId, 'capture:p1:0'));

        expect(error).toBeInstanceOf(PaymentGatewayError);
        expect(error?.retryWithFreshKey).toBe(false);
        expect(gateway.captureCalls(intentId)).toBe(0);
        await expect(gateway.capture(intentId, 'capture:p1:0')).resolves.toEqual({ kind: 'captured' });
      }
    });

    // What keeps a saga inside CAPTURING, under its lease, for as long as a test needs.
    it('parks the next capture until released, then lets it through exactly once', async () => {
      const { gateway, intentId } = await authorizedHold();
      const parked = gateway.hangCapture(intentId);

      let settled = false;
      const capturing = gateway.capture(intentId, 'capture:p1:0').finally(() => (settled = true));
      await parked.entered;
      await new Promise((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);
      expect(gateway.captureCalls(intentId)).toBe(0);
      parked.release();
      await expect(capturing).resolves.toEqual({ kind: 'captured' });
      expect(gateway.captureCalls(intentId)).toBe(1);
      await expect(gateway.capture(intentId, 'capture:p1:1')).resolves.toEqual({ kind: 'captured' });
    });

    it('refuses to capture a hold whose authorization lapsed', async () => {
      const { gateway, intentId } = await authorizedHold();
      gateway.failCapture(intentId, 'expired');

      await expect(gateway.capture(intentId, 'capture:p1:0')).resolves.toEqual({
        kind: 'not_capturable',
        intentStatus: 'canceled',
      });
    });

    it('voids a hold, and reads a captured one back instead of voiding it', async () => {
      const voided = await authorizedHold();
      const captured = await authorizedHold();
      await captured.gateway.capture(captured.intentId, 'capture:p1:0');

      await expect(voided.gateway.void(voided.intentId, 'void:p1:0')).resolves.toBe('voided');
      await expect(captured.gateway.void(captured.intentId, 'void:p2:0')).resolves.toBe('already_captured');
      expect(voided.gateway.wasVoided(voided.intentId)).toBe(true);
      expect(captured.gateway.wasVoided(captured.intentId)).toBe(false);
    });

    it('fails a void the way it fails a capture', async () => {
      const stuck = await authorizedHold();
      const landed = await authorizedHold();
      stuck.gateway.failVoid(stuck.intentId, 'server_error');
      landed.gateway.failVoid(landed.intentId, 'applied_then_500');

      expect((await rejection(stuck.gateway.void(stuck.intentId, 'void:p1:0')))?.retryWithFreshKey).toBe(true);
      await expect(stuck.gateway.void(stuck.intentId, 'void:p1:1')).resolves.toBe('voided');
      await expect(landed.gateway.void(landed.intentId, 'void:p2:0')).resolves.toBe('already_canceled');
      expect(landed.gateway.wasVoided(landed.intentId)).toBe(true);
    });

    // The window a concurrent cancel or webhook needs to land in.
    it('holds a session create or expire for the staged delay before it takes effect', async () => {
      vi.useFakeTimers();
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      gateway.delayCreateSession(1_000);
      gateway.delayExpireSession(1_000);

      let created = false;
      const creating = gateway
        .createSession({ orderId: 'o1', amountMinor: 1, currency: 'VND', captureMethod: 'manual' })
        .then((session) => {
          created = true;
          return session;
        });
      await vi.advanceTimersByTimeAsync(999);
      expect(created).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { providerSessionId } = await creating;

      const expiring = gateway.expireSession(providerSessionId);
      await vi.advanceTimersByTimeAsync(999);
      expect(gateway.wasExpired(providerSessionId)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(expiring).resolves.toBe('expired');
      expect(gateway.wasExpired(providerSessionId)).toBe(true);
    });
  });
});
