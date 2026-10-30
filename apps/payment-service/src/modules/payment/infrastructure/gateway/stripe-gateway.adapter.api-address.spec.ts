import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeGatewayAdapter, type StripeGatewayOptions } from './stripe-gateway.adapter';

const constructed = vi.hoisted(() => [] as unknown[][]);

vi.mock('stripe', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof Stripe }>();
  class RecordingStripe extends actual.default {
    constructor(...args: ConstructorParameters<typeof Stripe>) {
      constructed.push(args);
      super(...args);
    }
  }
  return { ...actual, default: RecordingStripe };
});

const LIVE: StripeGatewayOptions = {
  webhookSecret: 'whsec_test_secret_value_0000',
  toleranceSec: 300,
  secretKey: 'sk_test_not_a_real_key_0000',
  successUrl: 'https://app.test/ok',
  sessionMinTtlSec: 1800,
  sessionExpiryMarginSec: 120,
  captureTimeoutMs: 10_000,
};

const sdkOptions = () => constructed.at(-1)?.[1] as Record<string, unknown>;

describe('StripeGatewayAdapter: where the SDK sends requests', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('hands the SDK the host, port and protocol it is given', () => {
    new StripeGatewayAdapter({ ...LIVE, apiAddress: { host: 'fake-stripe', port: 12111, protocol: 'http' } });

    expect(sdkOptions()).toMatchObject({ host: 'fake-stripe', port: 12111, protocol: 'http' });
  });

  it('passes none of them without an address, so the SDK talks to Stripe', () => {
    new StripeGatewayAdapter(LIVE);

    expect(Object.keys(sdkOptions()).filter((key) => ['host', 'port', 'protocol'].includes(key))).toEqual([]);
  });
});
