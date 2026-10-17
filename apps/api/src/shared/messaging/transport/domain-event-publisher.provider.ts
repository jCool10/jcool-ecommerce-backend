import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { kafkaDomainEventPublisherFrom } from '../kafka/kafka-domain-event.publisher';
import { BullmqDomainEventPublisher } from '../queue/bullmq-domain-event.publisher';
import { DOMAIN_EVENTS_QUEUE, QUEUE_CONNECTION } from '../queue/queue.constants';
import { DOMAIN_EVENT_PUBLISHER, type DomainEventPublisher } from './domain-event-publisher.port';

// Builds only the chosen adapter, so only it connects and only its lifecycle hooks run. The BullMQ
// queue stays wired either way: its worker drains whatever an older deployment still publishes there.
export const DOMAIN_EVENT_PUBLISHER_PROVIDER: FactoryProvider<DomainEventPublisher> = {
  provide: DOMAIN_EVENT_PUBLISHER,
  inject: [ConfigService, DOMAIN_EVENTS_QUEUE, QUEUE_CONNECTION, PinoLogger],
  useFactory: (config: ConfigService, queue: Queue, connection: Redis, logger: PinoLogger) =>
    config.get<string>('messaging.transport') === 'kafka'
      ? kafkaDomainEventPublisherFrom(config, logger)
      : new BullmqDomainEventPublisher(queue, connection),
};
