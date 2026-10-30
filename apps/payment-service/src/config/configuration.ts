// Env is already validated (env.validation.ts); the defaults for omitted vars live here.
import {
  appConfig,
  databaseConfig,
  observabilityConfig,
  parseIntOr,
  redisConfig,
  resilienceConfig,
  retentionConfig,
} from '@jcool/platform/config';
import { callerTokensFromEnv } from '@jcool/platform/internal-api';

export default () => ({
  ...appConfig(),
  ...observabilityConfig({ serviceName: 'jcool-payment-service' }),
  ...databaseConfig(),
  ...redisConfig(),
  // Producer side of order-events only. BullMQ stamps these at `add`, so they must match the api's
  // values; the cross rule lives in RUNBOOK.md.
  queue: {
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
    consumerAttempts: parseIntOr(process.env.QUEUE_CONSUMER_ATTEMPTS, 8),
    consumerBackoffMs: parseIntOr(process.env.QUEUE_CONSUMER_BACKOFF_MS, 1000),
    // payment.authorized waits on Temporal on the consumer side, so it rides the long ladder.
    orderPaidAttempts: parseIntOr(process.env.ORDER_PAID_CONSUMER_ATTEMPTS, 15),
  },
  outbox: {
    relayEnabled: process.env.OUTBOX_RELAY_ENABLED !== 'false',
    pollMs: parseIntOr(process.env.OUTBOX_POLL_MS, 1000),
    batchSize: parseIntOr(process.env.OUTBOX_BATCH_SIZE, 100),
  },
  idService: {
    url: process.env.ID_SERVICE_URL,
    // Covers the gateway's retries across replicas, not one attempt.
    timeoutMs: parseIntOr(process.env.ID_SERVICE_TIMEOUT_MS, 2_000),
  },
  internalApi: {
    callers: callerTokensFromEnv(['api', 'order-service']),
  },
  payment: {
    // Kept as a boot-time assertion: env validation rejects anything but 'stripe'.
    provider: process.env.PAYMENT_PROVIDER ?? 'stripe',
    // Undefined → the Stripe adapter refuses to construct.
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
    // Replay window on the signature timestamp; 300s matches Stripe's default.
    webhookToleranceSec: parseIntOr(process.env.PAYMENT_WEBHOOK_TOLERANCE_SEC, 300),
    // Unset → the adapter fabricates cs_... sessions without calling Stripe (dev and test only).
    secretKey: process.env.STRIPE_SECRET_KEY,
    // No default: an unset value trips the adapter's live-key check at boot.
    successUrl: process.env.STRIPE_SUCCESS_URL,
    cancelUrl: process.env.STRIPE_CANCEL_URL ?? 'http://localhost:3000/payments/cancel',
    // Stripe refuses a session living under 30 minutes on its own clock; the margin absorbs the hop.
    sessionMinTtlSec: parseIntOr(process.env.PAYMENT_SESSION_MIN_TTL_SEC, 1_800),
    sessionExpiryMarginSec: parseIntOr(process.env.PAYMENT_SESSION_EXPIRY_MARGIN_SEC, 120),
    // The only bound on one capture/void/expire/retrieve: the Stripe SDK takes no AbortSignal.
    captureTimeoutMs: parseIntOr(process.env.PAYMENT_CAPTURE_TIMEOUT_MS, 10_000),
  },
  reconcile: {
    enabled: process.env.RECONCILE_ENABLED !== 'false',
    intervalMs: parseIntOr(process.env.RECONCILE_INTERVAL_MS, 60_000),
    batchSize: parseIntOr(process.env.RECONCILE_BATCH_SIZE, 50),
    // Below this age the webhook is probably still in flight; polling would only burn a call.
    staleAfterSec: parseIntOr(process.env.ORDER_STALE_THRESHOLD_SEC, 120),
  },
  retention: {
    ...retentionConfig().retention,
    // Published rows only; an unpublished one is never collected.
    outboxDays: parseIntOr(process.env.RETENTION_OUTBOX_DAYS, 30),
    // The replay defence at ingress, so it must outlast Stripe's ~72h redelivery.
    webhookEventDays: parseIntOr(process.env.RETENTION_WEBHOOK_EVENT_DAYS, 30),
  },
  ...resilienceConfig(),
});
