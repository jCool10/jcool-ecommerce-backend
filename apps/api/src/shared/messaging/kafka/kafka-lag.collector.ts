import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { OnApplicationShutdown, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { toError } from '@jcool/kernel';
import { timeout } from './abortable-timers';
import { createKafka } from './kafka-client.factory';
import { KafkaConsumerGroups } from './kafka-consumer-groups';

const LOG_CONTEXT = 'KafkaLagReader';

export const MESSAGING_CONSUMER_LAG = 'messaging_consumer_lag';

// A scrape awaits every collect(), so a stuck broker call must not hold the whole /metrics response.
const SCRAPE_TIMEOUT_MS = 2_000;

export type LagSource = { name: string; groupId: string; subscribedTopics: string[]; hasJoined(): boolean };

interface PartitionLag {
  group: string;
  topic: string;
  partition: number;
  lag: number;
}

interface PendingRead {
  lags: Promise<PartitionLag[]>;
  reported: boolean;
}

/**
 * Reads only groups this process has joined. On a fresh broker the admin's first offset fetch can wedge
 * it for good, and a disconnect then blocks the event loop; a member's assignment means the group
 * coordinator has already answered, which it has not been seen to do since.
 */
export class KafkaLagReader implements OnApplicationShutdown {
  private admin: KafkaJS.Admin | null = null;
  private pending: PendingRead | null = null;
  private lastReadOk = false;
  private closed = false;

  constructor(
    private readonly sources: () => readonly LagSource[],
    private readonly newAdmin: () => KafkaJS.Admin,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** Leaves the gauge as it was when nothing could be read, so a broker outage holds the last values. */
  async observe(gauge: Gauge<string>): Promise<void> {
    for (const { group, topic, partition, lag } of (await this.read()) ?? []) {
      gauge.set({ group, topic, partition: String(partition) }, lag);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    if (!this.admin) return;
    if (this.pending || !this.lastReadOk) {
      this.logger.warn('Kafka admin may be wedged, leaving it to the process exit');
      return;
    }
    await this.admin.disconnect().catch((error: unknown) => {
      this.logger.warn({ err: toError(error) }, 'Kafka admin disconnect failed');
    });
  }

  private async read(): Promise<PartitionLag[] | null> {
    if (this.closed) return null;
    const joined = this.sources().filter((source) => source.hasJoined());
    if (joined.length === 0) return null;

    // Cleared when the read settles, not when a scrape gives up on it, so a stuck call is waited on
    // by every later scrape instead of being joined by a new one each interval.
    const read = (this.pending ??= {
      lags: this.fetch(joined).finally(() => {
        this.pending = null;
      }),
      reported: false,
    });
    const limit = timeout(SCRAPE_TIMEOUT_MS);
    try {
      return await Promise.race([
        read.lags,
        limit.elapsed.then(() => {
          throw new Error(`consumer lag read exceeded ${SCRAPE_TIMEOUT_MS}ms`);
        }),
      ]);
    } catch (error) {
      this.lastReadOk = false;
      if (!read.reported) {
        read.reported = true;
        this.logger.warn({ err: toError(error) }, 'consumer lag scrape failed');
      }
      return null;
    } finally {
      limit.cancel();
    }
  }

  private async fetch(sources: LagSource[]): Promise<PartitionLag[]> {
    const admin = await this.connectedAdmin();
    const lags: PartitionLag[] = [];
    for (const { name, groupId, subscribedTopics } of sources) {
      const committed = new Map<string, bigint>();
      const groupOffsets = await admin.fetchOffsets({ groupId, topics: subscribedTopics, timeout: SCRAPE_TIMEOUT_MS });
      for (const { topic, partitions } of groupOffsets) {
        for (const { partition, offset } of partitions) committed.set(`${topic}:${partition}`, BigInt(offset));
      }

      for (const topic of subscribedTopics) {
        for (const { partition, low, high } of await admin.fetchTopicOffsets(topic)) {
          // Never committed: the fetch leaves the partition out, and the group is behind by all it retains.
          const from = committed.get(`${topic}:${partition}`) ?? -1n;
          lags.push({ group: name, topic, partition, lag: Number(BigInt(high) - (from >= 0n ? from : BigInt(low))) });
        }
      }
    }
    this.lastReadOk = true;
    return lags;
  }

  private async connectedAdmin(): Promise<KafkaJS.Admin> {
    if (this.admin) return this.admin;
    // Kept only once connected: one whose connect gave up never connects again.
    const admin = this.newAdmin();
    await admin.connect();
    this.admin = admin;
    return admin;
  }
}

export const KAFKA_LAG_PROVIDERS: Provider[] = [
  {
    provide: KafkaLagReader,
    inject: [KafkaConsumerGroups, ConfigService, PinoLogger],
    // The admin is built on the first read, which never comes with the worker off: no runner joins.
    useFactory: (groups: KafkaConsumerGroups, config: ConfigService, logger: PinoLogger) =>
      new KafkaLagReader(
        () => groups.runners,
        () =>
          createKafka(
            {
              brokers: config.getOrThrow<string[]>('kafka.brokers'),
              clientId: config.getOrThrow<string>('kafka.clientId'),
            },
            logger,
          ).admin(),
        logger,
      ),
  },
  // Same caveat as the outbox gauges: the registry keeps the first app's collect closure for the process.
  makeGaugeProvider({
    name: MESSAGING_CONSUMER_LAG,
    help: 'Messages a consumer group has yet to commit, per partition. Exported only by an instance running the worker.',
    labelNames: ['group', 'topic', 'partition'],
    inject: [KafkaLagReader],
    collect(this: Gauge<string>, reader: KafkaLagReader) {
      return reader.observe(this);
    },
  }),
];
