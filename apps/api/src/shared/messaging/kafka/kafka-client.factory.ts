import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from 'pino';

export interface KafkaConnection {
  brokers: string[];
  clientId: string;
}

export function createKafka({ brokers, clientId }: KafkaConnection, log: Logger): KafkaJS.Kafka {
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS is not set');
  return new KafkaJS.Kafka({ kafkaJS: { brokers, clientId, logger: kafkaLogger(log) } });
}

/**
 * The client hands a custom logger every line, librdkafka's and its own, and only reports the configured
 * level through setLogLevel, so the filtering happens here.
 */
export function kafkaLogger(log: Logger): KafkaJS.Logger {
  let level = KafkaJS.logLevel.INFO;

  const at =
    (threshold: KafkaJS.logLevel, write: (fields: object, message: string) => void) =>
    (message: string, extra?: object) => {
      if (level < threshold) return;
      // pino stamps its own time.
      const { timestamp: _, ...fields } = (extra ?? {}) as Record<string, unknown>;
      write(fields, message);
    };

  const logger: KafkaJS.Logger = {
    error: at(KafkaJS.logLevel.ERROR, (fields, message) => log.error(fields, message)),
    warn: at(KafkaJS.logLevel.WARN, (fields, message) => log.warn(fields, message)),
    info: at(KafkaJS.logLevel.INFO, (fields, message) => log.info(fields, message)),
    debug: at(KafkaJS.logLevel.DEBUG, (fields, message) => log.debug(fields, message)),
    namespace: () => logger,
    setLogLevel: (next) => {
      level = next;
    },
  };
  return logger;
}
