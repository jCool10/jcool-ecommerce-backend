import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { ProcessWebhookEventUseCase, type WebhookProcessResult } from './process-webhook-event.use-case';
import type { TccWebhookResult } from './process-tcc-webhook-event.use-case';

const LOG_CONTEXT = 'HandlePaymentWebhook';

/** Reports what the payment side decided. Orders move only through the checkout saga. */
@Injectable()
export class HandlePaymentWebhookUseCase {
  constructor(
    private readonly processWebhookEvent: ProcessWebhookEventUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult | TccWebhookResult> {
    const result = await this.processWebhookEvent.execute(rawBody, headers);
    if ('path' in result) {
      this.logger.info({ ...result }, 'participant webhook event handled');
      return result;
    }
    if (result.outcome === 'skipped') {
      const { providerEventId, eventType, sessionId } = result;
      if (result.moneyMoved) {
        this.metrics.recordRefundOwed('webhook_direct');
        this.logger.error(
          { providerEventId, eventType, sessionId },
          'gateway reported a cleared charge on a session no checkout owns — refund owed',
        );
      } else {
        this.logger.warn({ providerEventId, eventType, sessionId }, 'webhook event for a session no checkout owns');
      }
    } else if (result.outcome === 'duplicate' || result.outcome === 'ignored') {
      this.logger.debug(
        { outcome: result.outcome, providerEventId: result.providerEventId, eventType: result.eventType },
        'webhook event accepted but not applied',
      );
    }
    return result;
  }
}
