import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  GenericContainer,
  getContainerRuntimeClient,
  getReaper,
  LABEL_TESTCONTAINERS_SESSION_ID,
  StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

export const REPO_ROOT = resolve(__dirname, '../../..');
export const GATEWAY_IMAGE = 'jcool-gateway:system-test';
export const PUBLIC_PORT = 8080;
export const LB_PORT = 4000;
const FIXTURE_PORT = 3000;

export function buildGatewayImage(): Promise<unknown> {
  return GenericContainer.fromDockerfile(REPO_ROOT, 'apps/gateway/Dockerfile').build(GATEWAY_IMAGE, {
    deleteOnExit: false,
  });
}

/**
 * Dual-stack like Railway's private network, where a service name resolves to IPv4 and IPv6 alike.
 * testcontainers' own networks are IPv4 only. Containers take IPv6 addresses from `containerRange`,
 * which leaves out the bridge's own address: requests from the host arrive from it.
 */
export async function startDualStackNetwork(): Promise<{ network: StartedNetwork; containerRange: string }> {
  const client = await getContainerRuntimeClient();
  const reaper = await getReaper(client);
  const id = randomBytes(4).toString('hex');
  const prefix = `fd12:${id.slice(0, 4)}:${id.slice(4)}:`;
  const containerRange = `${prefix}:1:0/112`;
  const name = `gateway-dual-stack-${id}`;
  const network = await client.network.create({
    Name: name,
    Driver: 'bridge',
    EnableIPv6: true,
    IPAM: { Config: [{ Subnet: `${prefix}:/64`, IPRange: containerRange, Gateway: `${prefix}:1` }] },
    Labels: { [LABEL_TESTCONTAINERS_SESSION_ID]: reaper.sessionId },
  });
  return { network: new StartedNetwork(client, name, network), containerRange };
}

/** One of the node scripts in test/fixtures, reachable on the network as `alias`. */
export function startFixture(
  network: StartedNetwork,
  fixture: string,
  alias: string,
  env: Record<string, string> = {},
): Promise<StartedTestContainer> {
  return new GenericContainer('node:24-alpine')
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withEnvironment(env)
    .withCopyFilesToContainer([{ source: resolve(__dirname, 'fixtures', fixture), target: `/${fixture}` }])
    .withCommand(['node', `/${fixture}`])
    .withExposedPorts(FIXTURE_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
}

// Shutdown waits are for Railway's rollovers; a test stop would only sit through them. A zero grace
// period means an endless one to Caddy.
const FAST_STOP = { GATEWAY_SHUTDOWN_DELAY: '0s', GATEWAY_GRACE_PERIOD: '1ms' };

export function gatewayContainer(network: StartedNetwork, env: Record<string, string>): GenericContainer {
  return new GenericContainer(GATEWAY_IMAGE)
    .withNetwork(network)
    .withEnvironment({ ...FAST_STOP, ...env })
    .withExposedPorts(PUBLIC_PORT, LB_PORT);
}

export function startGateway(network: StartedNetwork, env: Record<string, string>): Promise<StartedTestContainer> {
  return gatewayContainer(network, env).withWaitStrategy(Wait.forHttp('/health/live', PUBLIC_PORT)).start();
}

export function urlOf(container: StartedTestContainer, port: number, path = ''): string {
  return `http://${container.getHost()}:${container.getMappedPort(port)}${path}`;
}

export const fixtureUrl = (container: StartedTestContainer, path = '') => urlOf(container, FIXTURE_PORT, path);

export async function hits(fixture: StartedTestContainer): Promise<number> {
  return Number(await (await fetch(fixtureUrl(fixture, '/__hits'))).text());
}
