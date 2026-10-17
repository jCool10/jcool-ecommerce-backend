import { createServer, type AddressInfo } from 'node:net';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const KAFKA_IMAGE = 'apache/kafka:4.3.1';

/** A port nothing listens on a moment ago. Also how a spec gets a broker address that refuses connections. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// The advertised listener has to name the port clients dial, which a random mapping only reveals after
// the broker has started. So the broker listens on a port picked up front and Docker maps it 1:1.
export async function startKafka(): Promise<{ container: StartedTestContainer; brokers: string }> {
  const port = await freePort();
  const container = await new GenericContainer(KAFKA_IMAGE)
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      // The controller binds loopback, as in compose and on Railway: one node has no peer to reach it.
      KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://localhost:9093`,
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_HEAP_OPTS: '-Xms256m -Xmx256m',
    })
    .withExposedPorts({ container: port, host: port })
    .withWaitStrategy(Wait.forLogMessage('Kafka Server started'))
    .start();
  const brokers = `127.0.0.1:${port}`;
  try {
    await warmGroupCoordinator(container, brokers);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return { container, brokers };
}

// The Node client's admin wedges for good when its first fetchOffsets lands while __consumer_offsets is
// still being created and loaded: the call times out, every later admin call does too, and disconnect()
// blocks the process. The Java tool retries through that load, so once it returns the coordinator is up.
async function warmGroupCoordinator(container: StartedTestContainer, brokers: string): Promise<void> {
  const { exitCode, output } = await container.exec([
    '/opt/kafka/bin/kafka-consumer-groups.sh',
    '--bootstrap-server',
    brokers,
    '--describe',
    '--group',
    'e2e.warmup',
  ]);
  if (!output.includes('GroupIdNotFoundException')) {
    throw new Error(`Kafka group coordinator warm-up failed (exit ${exitCode}): ${output}`);
  }
}
