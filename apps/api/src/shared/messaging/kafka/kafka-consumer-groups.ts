import { Inject, Injectable, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { ConsumerDelivery } from '../consume/consumer-delivery';
import { createKafka } from './kafka-client.factory';
import { KafkaConsumerGroupRunner } from './kafka-consumer-group.runner';
import { CONSUMER_GROUPS, type ConsumerName } from './kafka-topology';

const LOG_CONTEXT = 'KafkaConsumerGroups';

/**
 * Runs whenever the worker does, whichever transport the relay publishes to: a switch in either
 * direction then leaves nothing undrained. Closes alongside the BullMQ worker, in the same hook.
 */
@Injectable()
export class KafkaConsumerGroups implements OnModuleInit, BeforeApplicationShutdown {
  readonly runners: readonly KafkaConsumerGroupRunner[];

  constructor(
    config: ConfigService,
    delivery: ConsumerDelivery,
    cls: ClsService,
    @Inject(METRICS) metrics: MetricsPort,
    logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    if (config.get<boolean>('queue.workerEnabled') !== true) {
      this.runners = [];
      return;
    }

    const kafka = createKafka(
      { brokers: config.getOrThrow<string[]>('kafka.brokers'), clientId: config.getOrThrow<string>('kafka.clientId') },
      logger,
    );
    const settings = {
      prefix: config.getOrThrow<string>('kafka.prefix'),
      signingKey: config.getOrThrow<string>('messaging.signingKey'),
    };
    this.runners = (Object.keys(CONSUMER_GROUPS) as ConsumerName[]).map(
      (name) => new KafkaConsumerGroupRunner(name, (c) => kafka.consumer(c), settings, delivery, cls, metrics, logger),
    );
  }

  onModuleInit(): void {
    for (const runner of this.runners) runner.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.runners.map((runner) => runner.stop()));
  }
}
