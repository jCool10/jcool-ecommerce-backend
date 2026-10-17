import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { KafkaDomainEventPublisher } from '../kafka/kafka-domain-event.publisher';
import { BullmqDomainEventPublisher } from '../queue/bullmq-domain-event.publisher';
import { DOMAIN_EVENT_PUBLISHER_PROVIDER } from './domain-event-publisher.provider';

const config = (transport: string) =>
  new ConfigService({
    messaging: { transport, signingKey: 's'.repeat(32) },
    kafka: { brokers: ['127.0.0.1:9092'], clientId: 'jcool-api', prefix: 'jcool', deliveryTimeoutMs: 5_000 },
    resilience: { breaker: { resetTimeoutMs: 10_000 } },
  });

const build = (transport: string): unknown =>
  DOMAIN_EVENT_PUBLISHER_PROVIDER.useFactory(config(transport), {} as Queue, { status: 'ready' }, fakePinoLogger());

describe('domain event publisher provider', () => {
  it('publishes to BullMQ unless the transport says kafka', () => {
    expect(build('bullmq')).toBeInstanceOf(BullmqDomainEventPublisher);
    expect(build('kafka')).toBeInstanceOf(KafkaDomainEventPublisher);
  });
});
