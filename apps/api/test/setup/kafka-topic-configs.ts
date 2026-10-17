import { getContainerRuntimeClient } from 'testcontainers';
import { inject } from 'vitest';

const OVERRIDE_LINE = /^\s+([^=\s]+)=(\S*) sensitive=/;

/** A topic's overrides as the broker's own tool reports them; the Node client has no describeConfigs. */
export async function describeTopicConfigs(topic: string): Promise<Record<string, string>> {
  const runtime = await getContainerRuntimeClient();
  const { exitCode, stdout, output } = await runtime.container.exec(
    runtime.container.getById(inject('KAFKA_CONTAINER_ID')),
    [
      '/opt/kafka/bin/kafka-configs.sh',
      '--bootstrap-server',
      inject('KAFKA_BROKERS'),
      '--describe',
      '--entity-type',
      'topics',
      '--entity-name',
      topic,
    ],
  );
  if (exitCode !== 0) throw new Error(`kafka-configs.sh failed for ${topic}: ${output}`);

  return Object.fromEntries(
    stdout.split('\n').flatMap((line) => {
      const match = OVERRIDE_LINE.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}
