import { GenericContainer, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';

const TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0';
const API_PORT = 8474;

export interface ProxySpec {
  name: string;
  listenPort: number;
  upstream: string;
}

export type Toxic =
  | { type: 'latency'; stream: 'upstream' | 'downstream'; attributes: { latency: number; jitter?: number } }
  | { type: 'timeout'; stream: 'upstream' | 'downstream'; attributes: { timeout: number } };

export async function startToxiproxy(network: StartedNetwork, proxies: ProxySpec[]): Promise<Toxiproxy> {
  const container = await new GenericContainer(TOXIPROXY_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('toxiproxy')
    .withExposedPorts(API_PORT)
    .withWaitStrategy(Wait.forHttp('/version', API_PORT))
    .start();
  const toxiproxy = new Toxiproxy(container);
  for (const proxy of proxies) {
    await toxiproxy.request('POST', '/proxies', {
      name: proxy.name,
      listen: `0.0.0.0:${proxy.listenPort}`,
      upstream: proxy.upstream,
      enabled: true,
    });
  }
  return toxiproxy;
}

export class Toxiproxy {
  constructor(readonly container: StartedTestContainer) {}

  async addToxic(proxy: string, toxic: Toxic): Promise<void> {
    await this.request('POST', `/proxies/${proxy}/toxics`, { name: `${toxic.type}-${toxic.stream}`, ...toxic });
  }

  /**
   * Removes every toxic and re-enables every proxy. A latency toxic hands over what it holds; a
   * timeout toxic closes its connections.
   */
  async clearToxics(): Promise<void> {
    await this.request('POST', '/reset');
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://${this.container.getHost()}:${this.container.getMappedPort(API_PORT)}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${text}`);
    return text === '' ? undefined : JSON.parse(text);
  }
}
