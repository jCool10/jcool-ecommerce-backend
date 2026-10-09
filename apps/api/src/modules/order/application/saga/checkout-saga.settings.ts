import type { ConfigService } from '@nestjs/config';
import { requireIntConfig } from '@jcool/platform/config';
import type { SagaTiming } from '../../domain/checkout-saga';

export const CHECKOUT_SAGA_SETTINGS = Symbol('CHECKOUT_SAGA_SETTINGS');

export interface CheckoutSagaSettings {
  leaseMs: number;
  timing: SagaTiming;
  paymentDeadlineMs: number;
  payCutoffMs: number;
  tryTimeoutMs: number;
  holdSafetyMs: number;
}

export function checkoutSagaSettingsFrom(config: ConfigService): CheckoutSagaSettings {
  return {
    leaseMs: requireIntConfig(config, 'saga.leaseMs', 1),
    timing: {
      authGraceMs: requireIntConfig(config, 'saga.authGraceSec', 0) * 1000,
      retryBaseMs: requireIntConfig(config, 'saga.retryBaseMs', 1),
      retryCapMs: requireIntConfig(config, 'saga.retryCapMs', 1),
    },
    paymentDeadlineMs: requireIntConfig(config, 'checkout.paymentDeadlineSec', 1) * 1000,
    payCutoffMs: requireIntConfig(config, 'checkout.payCutoffSec', 0) * 1000,
    tryTimeoutMs: requireIntConfig(config, 'checkout.tryTimeoutMs', 1),
    holdSafetyMs: requireIntConfig(config, 'checkout.holdSafetySec', 1) * 1000,
  };
}
