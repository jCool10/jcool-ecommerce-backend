import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';

const DAY_MS = 86_400_000;

/**
 * The retention window that matters is the GATEWAY's, not the queue's: this table is read at ingress
 * only, through `insertIfNew`, so what a row must outlive is Stripe redelivering the same event
 * (~72h), not a dead-letter replay, which never touches this table.
 */
@Injectable()
export class SweepWebhookEventsUseCase implements RetentionSweep, OnModuleInit {
  readonly name = 'payment:webhook-events';
  private readonly retentionMs: number;

  constructor(
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.retentionMs = config.getOrThrow<number>('retention.webhookEventDays') * DAY_MS;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  sweep(batchSize: number): Promise<number> {
    return this.webhookEvents.deleteReceivedBefore(new Date(Date.now() - this.retentionMs), batchSize);
  }
}
