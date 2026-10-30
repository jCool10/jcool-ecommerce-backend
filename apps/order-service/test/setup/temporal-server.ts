import { Connection } from '@temporalio/client';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const TEMPORAL_IMAGE = 'temporalio/temporal:1.9.1';
const GRPC_PORT = 7233;
export const TEMPORAL_TEST_NAMESPACE = 'jcool';
const READY_TIMEOUT_MS = 60_000;

// A port nothing listens on, for the suites that need Temporal unreachable.
export const UNREACHABLE_TEMPORAL_ADDRESS = '127.0.0.1:1';

export interface StartedTemporalServer {
  address: string;
  stop: () => Promise<void>;
}

/**
 * The dev server, not time-skipping: the saga's timers are real seconds, and time-skipping would run
 * a different server than production. Same namespace and search attributes the entrypoint creates.
 */
export async function startTemporalServer(): Promise<StartedTemporalServer> {
  const container: StartedTestContainer = await new GenericContainer(TEMPORAL_IMAGE)
    .withCommand([
      'server',
      'start-dev',
      '--ip',
      '0.0.0.0',
      '--namespace',
      TEMPORAL_TEST_NAMESPACE,
      '--search-attribute',
      'CheckoutStep=Keyword',
      '--search-attribute',
      'CheckoutDeadlineAt=Datetime',
    ])
    .withExposedPorts(GRPC_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const address = `${container.getHost()}:${container.getMappedPort(GRPC_PORT)}`;
  try {
    await waitUntilReady(address);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return { address, stop: async () => void (await container.stop()) };
}

// The port opens before the namespace and its search attributes are registered.
async function waitUntilReady(address: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let connection: Connection | undefined;
    try {
      connection = await Connection.connect({ address, connectTimeout: 2_000 });
      const { customAttributes } = await connection.operatorService.listSearchAttributes({
        namespace: TEMPORAL_TEST_NAMESPACE,
      });
      if (customAttributes?.CheckoutStep && customAttributes.CheckoutDeadlineAt) return;
    } catch (error) {
      lastError = error;
    } finally {
      await connection?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Temporal dev server at ${address} not ready after ${READY_TIMEOUT_MS}ms`, { cause: lastError });
}
