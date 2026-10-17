import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKafka } from '../../src/shared/messaging/kafka/kafka-client.factory';
import { TOPIC_SPEC } from '../../src/shared/messaging/kafka/kafka-topology';
import { provisionTopics, TopicLayoutDriftError } from '../../src/shared/messaging/kafka/provision-topics';
import { freePort } from '../setup/kafka-container';
import { describeTopicConfigs } from '../setup/kafka-topic-configs';

const API_ROOT = resolve(__dirname, '../..');
const CLI = join(API_ROOT, 'src/shared/messaging/kafka/provision-topics.cli.ts');
const TSX = createRequire(join(API_ROOT, 'package.json')).resolve('tsx/cli');
// createTopics returns before the broker's metadata shows the topic; under a loaded run that takes a while.
const METADATA_SETTLES = { timeout: 10_000, interval: 100 };

function runCli(env: Record<string, string>): Promise<{ code: number | null; output: string; ms: number }> {
  const startedAt = Date.now();
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [TSX, CLI],
      { cwd: API_ROOT, env: { ...process.env, ...env }, timeout: 30_000 },
      (_error, stdout, stderr) => done({ code: child.exitCode, output: stdout + stderr, ms: Date.now() - startedAt }),
    );
  });
}

describe('Kafka topic provisioning (real broker)', () => {
  const run = `e2e.kafka-topic-provisioning.${Date.now()}`;
  const admin = createKafka(
    { brokers: process.env.KAFKA_BROKERS!.split(','), clientId: 'kafka-topic-provisioning' },
    pino({ level: 'silent' }),
  ).admin();

  beforeAll(() => admin.connect());

  afterAll(async () => {
    const ours = (await admin.listTopics()).filter((topic) => topic.startsWith(run));
    if (ours.length > 0) await admin.deleteTopics({ topics: ours });
    await admin.disconnect();
  });

  const partitionCounts = async (topics: string[]) =>
    Object.fromEntries(
      (await admin.fetchTopicMetadata({ topics })).map(({ name, partitions }) => [name, partitions.length]),
    );

  it('creates the three topics with the spec on the first run and nothing on the second', async () => {
    const prefix = `${run}.fresh`;
    const topics = ['order.events', 'payment.events', 'catalog.events'].map((topic) => `${prefix}.${topic}`);

    expect(await provisionTopics(admin, prefix)).toEqual({ created: topics, existing: [] });

    await vi.waitFor(
      async () => expect(await partitionCounts(topics)).toEqual(Object.fromEntries(topics.map((topic) => [topic, 3]))),
      METADATA_SETTLES,
    );
    for (const topic of topics) expect(await describeTopicConfigs(topic)).toEqual(TOPIC_SPEC.configs);
    expect(await provisionTopics(admin, prefix)).toEqual({ created: [], existing: topics });
  });

  it('refuses an existing topic with another partition count', async () => {
    const prefix = `${run}.drift`;
    const drifted = `${prefix}.payment.events`;
    await admin.createTopics({ topics: [{ topic: drifted, numPartitions: 1 }] });
    await vi.waitFor(async () => expect(await admin.listTopics()).toContain(drifted), METADATA_SETTLES);

    const error = await provisionTopics(admin, prefix).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TopicLayoutDriftError);
    expect(error).toMatchObject({ topic: drifted, expectedPartitions: 3, actualPartitions: 1 });
  });

  it('runs as a CLI against the broker and exits 0 on its own', async () => {
    const prefix = `${run}.cli`;

    const { code, output } = await runCli({ KAFKA_PREFIX: prefix });

    expect(output).toContain(`created  ${prefix}.order.events`);
    expect(code).toBe(0);
  });

  it('exits non-zero within 15s when the broker cannot be reached', async () => {
    const { code, output, ms } = await runCli({ KAFKA_BROKERS: `127.0.0.1:${await freePort()}` });

    // Proves the CLI itself ran: a tsx or import failure exits non-zero too.
    expect(output).toContain('provisioning topics with prefix');
    expect(code).not.toBe(0);
    expect(ms).toBeLessThan(15_000);
  }, 20_000);
});
