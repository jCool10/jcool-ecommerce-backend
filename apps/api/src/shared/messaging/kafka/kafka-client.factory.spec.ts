import { KafkaJS } from '@confluentinc/kafka-javascript';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createKafka, kafkaLogger } from './kafka-client.factory';

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { lines, log };
}

describe('kafkaLogger', () => {
  it('writes each client level to pino with the facility and client name, not the client timestamp', () => {
    const { lines, log } = capture();
    const logger = kafkaLogger(log);
    logger.setLogLevel(KafkaJS.logLevel.DEBUG);
    const extra = { fac: 'BINDING', name: 'jcool-api#consumer-1', timestamp: 1 };

    logger.error('e', extra);
    logger.warn('w', extra);
    logger.info('i', extra);
    logger.debug('d', extra);

    expect(lines.map(({ level, msg }) => [level, msg])).toEqual([
      [50, 'e'],
      [40, 'w'],
      [30, 'i'],
      [20, 'd'],
    ]);
    expect(lines[0]).toMatchObject({ fac: 'BINDING', name: 'jcool-api#consumer-1' });
    expect(lines[0]).not.toHaveProperty('timestamp');
  });

  it('drops what is above the level the client set, which it never filters itself', () => {
    const { lines, log } = capture();
    const logger = kafkaLogger(log);

    logger.debug('before');
    logger.setLogLevel(KafkaJS.logLevel.WARN);
    logger.info('info');
    logger.warn('warn');

    expect(lines.map(({ msg }) => msg)).toEqual(['warn']);
  });

  it('shares its level with namespaced loggers', () => {
    const { lines, log } = capture();
    const logger = kafkaLogger(log);

    logger.setLogLevel(KafkaJS.logLevel.ERROR);
    logger.namespace('admin').warn('dropped');
    logger.namespace('admin').error('kept');

    expect(lines.map(({ msg }) => msg)).toEqual(['kept']);
  });
});

describe('createKafka', () => {
  it('refuses an empty broker list instead of failing on the first connect', () => {
    expect(() => createKafka({ brokers: [], clientId: 'jcool-api' }, pino({ level: 'silent' }))).toThrow(
      'KAFKA_BROKERS is not set',
    );
  });
});
