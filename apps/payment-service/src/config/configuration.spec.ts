import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';

describe('configuration', () => {
  const keys = [
    'STRIPE_SUCCESS_URL',
    'INTERNAL_CALLER_TOKEN_API',
    'INTERNAL_CALLER_TOKEN_API_PREVIOUS',
    'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
    'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // A localhost default would pass the adapter's live-key guard and send charged buyers nowhere.
  it('leaves the Stripe success URL undefined when unset', () => {
    expect(configuration().payment.successUrl).toBeUndefined();
  });

  it('accepts the api and the order-service as callers, each with a current and previous token', () => {
    process.env.INTERNAL_CALLER_TOKEN_API = 'api-current';
    process.env.INTERNAL_CALLER_TOKEN_API_PREVIOUS = 'api-previous';
    process.env.INTERNAL_CALLER_TOKEN_ORDER_SERVICE = 'order-current';
    process.env.INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS = 'order-previous';

    expect(configuration().internalApi.callers).toEqual({
      api: ['api-current', 'api-previous'],
      'order-service': ['order-current', 'order-previous'],
    });
  });
});
