import type { CheckoutSagaSettings } from '../application/saga/checkout-saga.settings';

export function checkoutSagaSettings(overrides: Partial<CheckoutSagaSettings> = {}): CheckoutSagaSettings {
  return {
    paymentDeadlineMs: 3_600_000,
    payCutoffMs: 1_980_000,
    tryTimeoutMs: 3_000,
    holdSafetyMs: 3_600_000,
    authGraceMs: 180_000,
    reserveWaitMs: 6_000,
    cancelWaitMs: 10_000,
    reservingOrphanMs: 60_000,
    activityTimeoutMs: 60_000,
    retryBaseMs: 1_000,
    retryCapMs: 300_000,
    ...overrides,
  };
}
