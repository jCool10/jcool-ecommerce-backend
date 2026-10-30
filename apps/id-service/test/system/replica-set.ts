import { resolve } from 'node:path';
import { EtcdContainer, type StartedEtcdContainer } from '@testcontainers/etcd';
import { Etcd3 } from 'etcd3';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { decode } from '@jcool/id-codec';
import { LEASED_NODE_MAX } from '@jcool/id-generator';

/** Small, as callers mint, so the load arrives as many concurrent requests rather than a few large ones. */
export const IDS_PER_REQUEST = 32;

const REPO_ROOT = resolve(__dirname, '../../../..');
const ID_SERVICE_IMAGE = 'jcool-id-service:system-test';
const GATEWAY_IMAGE = 'jcool-gateway:system-test';
const ETCD_IMAGE = 'gcr.io/etcd-development/etcd:v3.6.5';
const ID_SERVICE_ALIAS = 'id-service';
const ETCD_ENDPOINTS = 'http://id-etcd:2379';
// The image's default, which the replicas below run under.
const KEY_PREFIX = '/jcool/id-service/';
const LB_PORT = 4000;
export const SHUTDOWN_GRACE_MS = 3_000;

export async function buildImages(): Promise<void> {
  await Promise.all([
    GenericContainer.fromDockerfile(REPO_ROOT, 'apps/id-service/Dockerfile').build(ID_SERVICE_IMAGE, {
      deleteOnExit: false,
    }),
    GenericContainer.fromDockerfile(REPO_ROOT, 'apps/gateway/Dockerfile').build(GATEWAY_IMAGE, { deleteOnExit: false }),
  ]);
}

export interface Stack {
  network: StartedNetwork;
  etcd: StartedEtcdContainer;
  gateway: StartedTestContainer;
  replicas: StartedTestContainer[];
  lbUrl: string;
}

export interface StackOptions {
  /** Extra environment for every replica, such as short lease timings. */
  env?: Record<string, string>;
  /** Leaves only nodes 1..freeNodes claimable, so a new replica gets a node only once one changes hands. */
  freeNodes?: number;
}

/** etcd given floors by the image's own pre-deploy command, `count` replicas, and the gateway in front. */
export async function startStack(count = 3, { env = {}, freeNodes }: StackOptions = {}): Promise<Stack> {
  const network = await new Network().start();
  const etcd = await new EtcdContainer(ETCD_IMAGE).withNetwork(network).withNetworkAliases('id-etcd').start();
  await new GenericContainer(ID_SERVICE_IMAGE)
    .withNetwork(network)
    .withEnvironment({ ETCD_ENDPOINTS })
    .withCommand(['node', 'dist/lease/lift-floors-cli.js', '--if-uninitialized'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();
  if (freeNodes !== undefined) await reserveNodesAbove(etcd, freeNodes);

  const replicas = await startReplicas(network, count, env);
  const gateway = await new GenericContainer(GATEWAY_IMAGE)
    .withNetwork(network)
    .withEnvironment({
      ID_LB_PORT: String(LB_PORT),
      ID_SERVICE_HOST: ID_SERVICE_ALIAS,
      ID_SERVICE_PORT: '3000',
      // Required by the public site, which these tests never call.
      API_UPSTREAM: 'api:3000',
      INVENTORY_UPSTREAM: 'inventory:3000',
      PAYMENT_UPSTREAM: 'payment:3000',
      ORDER_UPSTREAM: 'order:3000',
      GATEWAY_SHUTDOWN_DELAY: '0s',
      // Zero would be an endless grace period to Caddy.
      GATEWAY_GRACE_PERIOD: '1ms',
    })
    .withExposedPorts(8080, LB_PORT)
    .withWaitStrategy(Wait.forHttp('/health/live', 8080))
    .start();
  const lbUrl = `http://${gateway.getHost()}:${gateway.getMappedPort(LB_PORT)}`;
  return { network, etcd, gateway, replicas, lbUrl };
}

export function startReplicas(
  network: StartedNetwork,
  count: number,
  env: Record<string, string> = {},
): Promise<StartedTestContainer[]> {
  return Promise.all(
    Array.from({ length: count }, () =>
      new GenericContainer(ID_SERVICE_IMAGE)
        .withNetwork(network)
        .withNetworkAliases(ID_SERVICE_ALIAS)
        .withEnvironment({
          NODE_ENV: 'production',
          ETCD_ENDPOINTS,
          LOG_LEVEL: 'warn',
          SHUTDOWN_GRACE_PERIOD_MS: String(SHUTDOWN_GRACE_MS),
          ...env,
        })
        .withExposedPorts(3000)
        .withWaitStrategy(Wait.forHttp('/health/ready', 3000))
        .start(),
    ),
  );
}

// Written the way a holder writes its owner key, under a lease that outlives the test.
async function reserveNodesAbove(etcd: StartedEtcdContainer, freeNodes: number): Promise<void> {
  const client = new Etcd3({ hosts: etcd.getClientEndpoint() });
  try {
    const { ID } = await client.leaseClient.leaseGrant({ TTL: 3_600 });
    const owner = Buffer.from(JSON.stringify({ holder: 'reserved', claimFloorMs: null }));
    for (let nodeId = freeNodes + 1; nodeId <= LEASED_NODE_MAX; nodeId++) {
      const key = Buffer.from(`${KEY_PREFIX}nodes/${String(nodeId).padStart(3, '0')}/owner`);
      await client.kv.put({ key, value: owner, lease: ID });
    }
  } finally {
    client.close();
  }
}

/** A replica's readiness, and the node it holds while ready. */
export async function readiness(replica: StartedTestContainer): Promise<{ status: number; nodeId?: number }> {
  const res = await fetch(`http://${replica.getHost()}:${replica.getMappedPort(3000)}/health/ready`);
  const body = (await res.json()) as { info?: { lease?: { nodeId?: number } } };
  return { status: res.status, nodeId: body.info?.lease?.nodeId };
}

export async function stopStack(stack: Stack | undefined): Promise<void> {
  if (stack === undefined) return;
  await Promise.allSettled([stack.gateway.stop(), ...stack.replicas.map((replica) => replica.stop({ timeout: 0 }))]);
  await stack.etcd.stop();
  await stack.network.stop();
}

export interface MintRun {
  ids: string[];
  failures: { status: number; body: string }[];
  maxLatencyMs: number;
}

/** `workers` callers minting through the load balancer until `until` resolves. */
export async function mintUntil(
  lbUrl: string,
  until: Promise<unknown>,
  workers = 8,
  count = IDS_PER_REQUEST,
): Promise<MintRun> {
  const run: MintRun = { ids: [], failures: [], maxLatencyMs: 0 };
  let done = false;
  const stop = () => {
    done = true;
  };
  until.then(stop, stop);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!done) await mintInto(run, lbUrl, count);
    }),
  );
  return run;
}

export async function mintTimes(lbUrl: string, requests: number, workers: number, count: number): Promise<MintRun> {
  const run: MintRun = { ids: [], failures: [], maxLatencyMs: 0 };
  let remaining = requests;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (remaining-- > 0) await mintInto(run, lbUrl, count);
    }),
  );
  return run;
}

async function mintInto(run: MintRun, lbUrl: string, count: number): Promise<void> {
  const startedAt = Date.now();
  const res = await fetch(`${lbUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-caller': 'system-test' },
    body: JSON.stringify({ count }),
  });
  run.maxLatencyMs = Math.max(run.maxLatencyMs, Date.now() - startedAt);
  if (res.status !== 200) {
    run.failures.push({ status: res.status, body: await res.text() });
    return;
  }
  run.ids.push(...((await res.json()) as { ids: string[] }).ids);
}

/** Repeated (timestamp, node, sequence) triples, and the nodes that minted. A repeated id repeats its
 * triple. */
export function collisions(ids: string[]): { duplicates: number; nodes: Set<number> } {
  const triples = new Set<string>();
  const nodes = new Set<number>();
  let duplicates = 0;
  for (const id of ids) {
    const { tsMs, nodeId, sequence } = decode(id);
    nodes.add(nodeId);
    const triple = `${tsMs}:${nodeId}:${sequence}`;
    if (triples.has(triple)) duplicates += 1;
    triples.add(triple);
  }
  return { duplicates, nodes };
}
