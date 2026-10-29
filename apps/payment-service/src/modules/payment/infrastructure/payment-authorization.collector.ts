import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, type Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { eq, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { toError } from '@jcool/kernel';
import { createCollectorBinding } from '@jcool/platform/metrics';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { PaymentOrderStatus } from '../domain/payment-order-status';
import { paymentOrders } from './schema/payment.schema';

const LOG_CONTEXT = 'PaymentAuthorizationCollector';

export const PAYMENT_AUTHORIZED_UNCAPTURED_OLDEST_SECONDS = 'payment_authorized_uncaptured_oldest_seconds';

// Same budget as the outbox gauge: a query stuck behind a lock must not hang /metrics.
const SCRAPE_TIMEOUT_MS = 2_000;
const WARN_EVERY_MS = 60_000;

interface ScrapeSource {
  db: DrizzleDB;
  logger: PinoLogger;
  lastWarnAt: number;
}

const binding = createCollectorBinding<ScrapeSource>();
// Cleared when the query settles, not when a scrape gives up on it, so a stuck query costs one pool
// client however many scrapes time out against it.
let pending: Promise<number> | null = null;

async function queryOldestSeconds(db: DrizzleDB): Promise<number> {
  const [row] = await db
    .select({
      // Database clock, and 0 rather than NULL when nothing waits: a blank series cannot fire.
      oldestSeconds: sql<string>`coalesce(extract(epoch from now() - min(${paymentOrders.authorizedAt})), 0)`,
    })
    .from(paymentOrders)
    .where(eq(paymentOrders.status, PaymentOrderStatus.AUTHORIZED));
  return Number(row.oldestSeconds);
}

/** Null on failure, so the gauge holds its last value: the database has its own health signal. */
async function readOldestSeconds(source: ScrapeSource): Promise<number | null> {
  const query = (pending ??= queryOldestSeconds(source.db).finally(() => {
    pending = null;
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`query exceeded ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const now = Date.now();
    if (now - source.lastWarnAt >= WARN_EVERY_MS) {
      source.lastWarnAt = now;
      source.logger.warn({ err: toError(error) }, 'payment authorization scrape failed, gauge holds its last value');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class PaymentAuthorizationCollectorBinding implements OnModuleInit, OnModuleDestroy {
  private readonly source: ScrapeSource;

  constructor(@Inject(DRIZZLE) db: DrizzleDB, logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
    this.source = { db, logger, lastWarnAt: -Infinity };
  }

  onModuleInit(): void {
    binding.bind(this.source);
  }

  onModuleDestroy(): void {
    binding.unbind(this.source);
  }
}

export const PAYMENT_AUTHORIZATION_COLLECTOR_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: PAYMENT_AUTHORIZED_UNCAPTURED_OLDEST_SECONDS,
    help: 'Seconds since the oldest payment still AUTHORIZED was authorized, i.e. money held but neither captured nor released (0 when none).',
    async collect(this: Gauge<string>) {
      const source = binding.current();
      if (!source) {
        this.remove();
        return;
      }
      const seconds = await readOldestSeconds(source);
      if (seconds !== null) this.set(seconds);
    },
  }),
  PaymentAuthorizationCollectorBinding,
];
