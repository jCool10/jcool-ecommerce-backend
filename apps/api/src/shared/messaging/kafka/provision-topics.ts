import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { KAFKA_PREFIX_PATTERN, qualifiedTopic, TOPIC_SPEC, TOPICS } from './kafka-topology';

export type ProvisioningAdmin = Pick<KafkaJS.Admin, 'listTopics' | 'fetchTopicMetadata' | 'createTopics'>;

export class TopicLayoutDriftError extends Error {
  constructor(
    readonly topic: string,
    readonly expectedPartitions: number,
    readonly actualPartitions: number,
  ) {
    super(`Topic ${topic} has ${actualPartitions} partitions, expected ${expectedPartitions}`);
    this.name = 'TopicLayoutDriftError';
  }
}

/**
 * Creates the missing topics with TOPIC_SPEC and checks the partition count of the existing ones. Configs
 * are only applied on create: the client has no describeConfigs, so drift there is a RUNBOOK check.
 */
export async function provisionTopics(
  admin: ProvisioningAdmin,
  prefix: string,
): Promise<{ created: string[]; existing: string[] }> {
  // The CLI reads the environment without the app's validation.
  if (!KAFKA_PREFIX_PATTERN.test(prefix)) throw new Error(`KAFKA_PREFIX "${prefix}" is not a valid topic prefix`);

  const wanted = TOPICS.map(({ topic }) => qualifiedTopic(prefix, topic));
  const present = new Set(await admin.listTopics());
  const existing = wanted.filter((topic) => present.has(topic));
  await assertPartitions(admin, existing);

  const configEntries = Object.entries(TOPIC_SPEC.configs).map(([name, value]) => ({ name, value }));
  const created: string[] = [];
  const appeared: string[] = [];
  // One topic per call: createTopics answers false when a topic already exists, which happens when the
  // listing was stale or someone created it meanwhile. Those get the same check as the listed ones.
  for (const topic of wanted.filter((name) => !present.has(name))) {
    const isNew = await admin.createTopics({
      topics: [{ topic, numPartitions: TOPIC_SPEC.numPartitions, configEntries }],
    });
    (isNew ? created : appeared).push(topic);
  }
  await assertPartitions(admin, appeared);

  return { created, existing: [...existing, ...appeared] };
}

async function assertPartitions(admin: ProvisioningAdmin, topics: string[]): Promise<void> {
  if (topics.length === 0) return;
  for (const { name, partitions } of await admin.fetchTopicMetadata({ topics })) {
    if (partitions.length !== TOPIC_SPEC.numPartitions) {
      throw new TopicLayoutDriftError(name, TOPIC_SPEC.numPartitions, partitions.length);
    }
  }
}
