import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from './configuration';

describe('configuration', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.STRIPE_SUCCESS_URL;
    delete process.env.STRIPE_SUCCESS_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_SUCCESS_URL;
    else process.env.STRIPE_SUCCESS_URL = saved;
  });

  // A localhost default would pass the adapter's live-key guard and send charged buyers nowhere.
  it('leaves the Stripe success URL undefined when unset', () => {
    expect(configuration().payment.successUrl).toBeUndefined();
  });
});
