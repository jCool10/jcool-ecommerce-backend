import type { ConfigService } from '@nestjs/config';
import { requireIntConfig } from '@jcool/platform/config';

export const CHECKOUT_SAGA_SETTINGS = Symbol('CHECKOUT_SAGA_SETTINGS');

export interface CheckoutSagaSettings {
  paymentDeadlineMs: number;
  payCutoffMs: number;
  tryTimeoutMs: number;
  holdSafetyMs: number;
  authGraceMs: number;
  reserveWaitMs: number;
  cancelWaitMs: number;
  reservingOrphanMs: number;
  activityTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
}

export function checkoutSagaSettingsFrom(config: ConfigService): CheckoutSagaSettings {
  return {
    paymentDeadlineMs: requireIntConfig(config, 'checkout.paymentDeadlineSec', 1) * 1000,
    payCutoffMs: requireIntConfig(config, 'checkout.payCutoffSec', 0) * 1000,
    tryTimeoutMs: requireIntConfig(config, 'checkout.tryTimeoutMs', 1),
    holdSafetyMs: requireIntConfig(config, 'checkout.holdSafetySec', 1) * 1000,
    authGraceMs: requireIntConfig(config, 'saga.authGraceSec', 0) * 1000,
    reserveWaitMs: requireIntConfig(config, 'checkout.reserveWaitMs', 1),
    cancelWaitMs: requireIntConfig(config, 'checkout.cancelWaitMs', 1),
    reservingOrphanMs: requireIntConfig(config, 'checkout.reservingOrphanSec', 1) * 1000,
    activityTimeoutMs: requireIntConfig(config, 'saga.activityTimeoutMs', 1),
    retryBaseMs: requireIntConfig(config, 'saga.retryBaseMs', 1),
    retryCapMs: requireIntConfig(config, 'saga.retryCapMs', 1),
  };
}
