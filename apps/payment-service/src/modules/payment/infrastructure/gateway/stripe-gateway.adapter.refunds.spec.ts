import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeGatewayAdapter, type StripeGatewayOptions } from './stripe-gateway.adapter';
import { PaymentGatewayError, type RefundIntentInput } from '../../application/ports/payment-gateway.port';

const CAPTURE_TIMEOUT_MS = 10_000;
const BOUNDED = { timeout: CAPTURE_TIMEOUT_MS, maxNetworkRetries: 0 };
const KEY = 'refund:8001:0';

const INPUT: RefundIntentInput = {
  intentId: 'pi_1',
  amountMinor: 150_000,
  currency: 'VND',
  orderId: '7001',
  requestedBy: '9001',
};

type StripeClient = NonNullable<StripeGatewayOptions['stripeClient']>;

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 're_1',
    object: 'refund',
    amount: INPUT.amountMinor,
    currency: 'vnd',
    status: 'succeeded',
    failure_reason: null,
    payment_intent: INPUT.intentId,
    metadata: { order_id: INPUT.orderId, requested_by: INPUT.requestedBy },
    ...overrides,
  };
}

function refundsAdapter(refunds: { create?: unknown; list?: unknown; retrieve?: unknown }) {
  const create = vi.fn(refunds.create as (...args: unknown[]) => unknown);
  const list = vi.fn(refunds.list as (...args: unknown[]) => unknown);
  const retrieve = vi.fn(refunds.retrieve as (...args: unknown[]) => unknown);
  const gateway = new StripeGatewayAdapter({
    webhookSecret: 'whsec_test_secret_value_0000',
    toleranceSec: 300,
    sessionMinTtlSec: 1_800,
    sessionExpiryMarginSec: 120,
    captureTimeoutMs: CAPTURE_TIMEOUT_MS,
    successUrl: 'https://app.test/ok',
    stripeClient: { checkout: {}, paymentIntents: {}, refunds: { create, list, retrieve } } as unknown as StripeClient,
  });
  return { gateway, create, list, retrieve };
}

const listed = (...data: unknown[]) => Promise.resolve({ object: 'list', data, has_more: false });

function stripeError(
  statusCode: number,
  code?: string,
  type: Stripe.StripeRawError['type'] = 'invalid_request_error',
  param?: string,
) {
  return Stripe.errors.StripeError.generate({ statusCode, type, code, param, message: 'stripe says no' });
}

async function refusal(promise: Promise<unknown>): Promise<PaymentGatewayError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PaymentGatewayError)) throw new Error(`expected a PaymentGatewayError, got ${String(error)}`);
  return error;
}

describe('StripeGatewayAdapter refunds', () => {
  describe('refundIntent', () => {
    it('refunds the intent the given amount, under the given key, naming the order and the admin', async () => {
      const { gateway, create } = refundsAdapter({ create: () => Promise.resolve(refund()) });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toEqual({
        refundId: 're_1',
        intentId: 'pi_1',
        metadataOrderId: '7001',
        amountMinor: 150_000,
        currency: 'vnd',
        status: 'succeeded',
        failureReason: null,
      });
      expect(create).toHaveBeenCalledWith(
        {
          payment_intent: 'pi_1',
          amount: 150_000,
          reason: 'requested_by_customer',
          metadata: { order_id: '7001', requested_by: '9001' },
        },
        { idempotencyKey: KEY, ...BOUNDED },
      );
    });

    it.each(['pending', 'requires_action', 'failed', 'canceled'])(
      'reports a refund Stripe holds as %s',
      async (status) => {
        const { gateway } = refundsAdapter({
          create: () =>
            Promise.resolve(refund({ status, failure_reason: status === 'failed' ? 'lost_or_stolen_card' : null })),
        });

        await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({
          status,
          failureReason: status === 'failed' ? 'lost_or_stolen_card' : null,
        });
      },
    );

    it('reads an unknown refund status as pending rather than settled', async () => {
      const { gateway } = refundsAdapter({ create: () => Promise.resolve(refund({ status: null })) });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({ status: 'pending' });
    });

    it('adopts the refund a 5xx applied, found by the intent with no metadata', async () => {
      const { gateway, list } = refundsAdapter({
        create: () => Promise.reject(stripeError(500, undefined, 'api_error')),
        list: () => listed(refund({ id: 're_9', amount: 1 }), refund({ metadata: {} })),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({ refundId: 're_1', status: 'succeeded' });
      expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 }, BOUNDED);
    });

    it('adopts its own refund that failed after a 5xx, rather than refunding again', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(502, undefined, 'api_error')),
        list: () => listed(refund({ status: 'failed', failure_reason: 'expired_or_canceled_card' })),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({ refundId: 're_1', status: 'failed' });
    });

    it('prefers a live refund over a failed earlier one of its own after a 5xx', async () => {
      const failedOurs = refund({ id: 're_old', status: 'failed', failure_reason: 'expired_or_canceled_card' });
      const cases = [
        [failedOurs, refund({ id: 're_new' })],
        [failedOurs, refund({ id: 're_new', metadata: {} })],
      ];

      const adopted = await Promise.all(
        cases.map((listing) =>
          refundsAdapter({
            create: () => Promise.reject(stripeError(500, undefined, 'api_error')),
            list: () => listed(...listing),
          }).gateway.refundIntent(INPUT, KEY),
        ),
      );

      expect(adopted.map(({ refundId, status }) => [refundId, status])).toEqual([
        ['re_new', 'succeeded'],
        ['re_new', 'succeeded'],
      ]);
    });

    it('asks for a fresh key after a 5xx that refunded nothing', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(500, undefined, 'api_error')),
        list: () => listed(refund({ status: 'failed', metadata: {} })),
      });

      expect((await refusal(gateway.refundIntent(INPUT, KEY))).retryWithFreshKey).toBe(true);
    });

    it.each([
      ['a request still in flight under the key', stripeError(409, 'idempotency_key_in_use', 'idempotency_error')],
      ['a lock timeout', stripeError(429, 'lock_timeout')],
    ])('keeps the key after %s that refunded nothing yet', async (_label, error) => {
      const { gateway } = refundsAdapter({ create: () => Promise.reject(error), list: () => listed() });

      expect((await refusal(gateway.refundIntent(INPUT, KEY))).retryWithFreshKey).toBe(false);
    });

    it('adopts the refund an in-flight request under the same key already made', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(409, 'idempotency_key_in_use', 'idempotency_error')),
        list: () => listed(refund({ status: 'pending' })),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({ refundId: 're_1', status: 'pending' });
    });

    it('keeps the key after a timeout, without reading back', async () => {
      const { gateway, list } = refundsAdapter({
        create: () => Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'timed out' })),
      });

      expect((await refusal(gateway.refundIntent(INPUT, KEY))).retryWithFreshKey).toBe(false);
      expect(list).not.toHaveBeenCalled();
    });

    it('adopts one full refund made elsewhere with no metadata once Stripe says the charge is refunded', async () => {
      const dashboard = refund({ id: 're_dash', metadata: {} });
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(400, 'charge_already_refunded')),
        list: () => listed(dashboard),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toEqual({
        refundId: 're_dash',
        intentId: 'pi_1',
        metadataOrderId: null,
        amountMinor: 150_000,
        currency: 'vnd',
        status: 'succeeded',
        failureReason: null,
      });
    });

    it('adopts partial refunds that add up to the captured amount, naming none of them', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(400, 'charge_already_refunded')),
        list: () =>
          listed(
            refund({ id: 're_a', amount: 100_000, metadata: {} }),
            refund({ id: 're_b', amount: 50_000, metadata: {}, status: 'pending' }),
            refund({ id: 're_dead', amount: 150_000, status: 'failed', metadata: {} }),
          ),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toEqual({
        refundId: null,
        intentId: 'pi_1',
        metadataOrderId: null,
        amountMinor: 150_000,
        currency: 'vnd',
        status: 'pending',
        failureReason: null,
        coveredBy: ['re_a', 're_b'],
      });
    });

    // Stripe replays the refusal under the key after a covering refund failed; only a new key asks again.
    it('asks again under a fresh key when the charge reads refunded but its refunds fall short', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(400, 'charge_already_refunded')),
        list: () => listed(refund({ amount: 100_000, metadata: {} })),
      });

      expect((await refusal(gateway.refundIntent(INPUT, KEY))).retryWithFreshKey).toBe(true);
    });

    it('adopts a refunded charge even when the refusal names the amount', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(400, 'charge_already_refunded', 'invalid_request_error', 'amount')),
        list: () => listed(refund({ id: 're_dash', metadata: {} })),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({
        refundId: 're_dash',
        status: 'succeeded',
      });
    });

    it('settles any refusal of the amount itself as final, whatever code Stripe gives it', async () => {
      const { gateway, list } = refundsAdapter({
        create: () => Promise.reject(stripeError(400, undefined, 'invalid_request_error', 'amount')),
      });

      await expect(gateway.refundIntent(INPUT, KEY)).resolves.toMatchObject({
        refundId: null,
        status: 'failed',
        failureReason: 'amount_rejected',
      });
      expect(list).not.toHaveBeenCalled();
    });

    it.each(['amount_too_large', 'charge_disputed', 'refund_disputed_payment'])(
      'settles the refusal %s as a failed refund carrying the code',
      async (code) => {
        const { gateway, list } = refundsAdapter({ create: () => Promise.reject(stripeError(400, code)) });

        await expect(gateway.refundIntent(INPUT, KEY)).resolves.toEqual({
          refundId: null,
          intentId: 'pi_1',
          metadataOrderId: null,
          amountMinor: 150_000,
          currency: 'VND',
          status: 'failed',
          failureReason: code,
        });
        expect(list).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['after a 5xx', stripeError(500, undefined, 'api_error')],
      ['once the charge reads refunded', stripeError(400, 'charge_already_refunded')],
    ])('never adopts a refund whose metadata names another order, %s', async (_label, error) => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(error),
        list: () => listed(refund({ metadata: { order_id: '7999' } })),
      });

      const thrown = await refusal(gateway.refundIntent(INPUT, KEY));
      expect(thrown.message).toMatch(/refund metadata names another order/);
      expect(thrown.retryWithFreshKey).toBe(false);
    });

    it('throws when the read-back itself fails, keeping the key', async () => {
      const { gateway } = refundsAdapter({
        create: () => Promise.reject(stripeError(500, undefined, 'api_error')),
        list: () => Promise.reject(stripeError(503, undefined, 'api_error')),
      });

      expect((await refusal(gateway.refundIntent(INPUT, KEY))).retryWithFreshKey).toBe(false);
    });

    it('refuses offline instead of pretending to refund', async () => {
      const offline = new StripeGatewayAdapter({
        webhookSecret: 'whsec_test_secret_value_0000',
        toleranceSec: 300,
        sessionMinTtlSec: 1_800,
        sessionExpiryMarginSec: 120,
        captureTimeoutMs: CAPTURE_TIMEOUT_MS,
      });

      await expect(offline.refundIntent(INPUT, KEY)).rejects.toThrow(/not configured/);
      await expect(offline.retrieveRefund('re_1')).rejects.toThrow(/not configured/);
    });
  });

  describe('retrieveRefund', () => {
    it('reads the refund back with its intent expanded or bare', async () => {
      const { gateway, retrieve } = refundsAdapter({
        retrieve: () => Promise.resolve(refund({ payment_intent: { id: 'pi_1' }, status: 'pending' })),
      });

      await expect(gateway.retrieveRefund('re_1')).resolves.toMatchObject({
        refundId: 're_1',
        intentId: 'pi_1',
        status: 'pending',
      });
      expect(retrieve).toHaveBeenCalledWith('re_1', undefined, BOUNDED);
    });

    it('reports a refund with no intent and no metadata as such', async () => {
      const { gateway } = refundsAdapter({
        retrieve: () => Promise.resolve(refund({ payment_intent: null, metadata: null })),
      });

      await expect(gateway.retrieveRefund('re_1')).resolves.toMatchObject({ intentId: null, metadataOrderId: null });
    });

    it('throws when Stripe cannot answer', async () => {
      const { gateway } = refundsAdapter({ retrieve: () => Promise.reject(stripeError(500, undefined, 'api_error')) });

      await expect(gateway.retrieveRefund('re_1')).rejects.toBeInstanceOf(PaymentGatewayError);
    });
  });
});
