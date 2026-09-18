import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { decode } from '@jcool/id-codec';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ID_SERVICE_IMAGE = 'jcool-id-service:system-test';
const GATEWAY_IMAGE = 'jcool-gateway:system-test';
const ID_SERVICE_ALIAS = 'id-service';
const DATABASE_URL = 'postgresql://ids:ids@id-postgres:5432/ids';
const LB_PORT = 4000;
export const SHUTDOWN_GRACE_MS = 3_000;

export async function buildImages(): Promise<void> {
  await Promise.all([
    GenericContainer.fromDockerfile(REPO_ROOT, 'apps/id-service/Dockerfile').build(ID_SERVICE_IMAGE, {
      deleteOnExit: false,
    }),
    GenericContainer.fromDockerfile(resolve(REPO_ROOT, 'apps/gateway')).build(GATEWAY_IMAGE, { deleteOnExit: false }),
  ]);
}

export interface Stack {
  network: StartedNetwork;
  postgres: StartedPostgreSqlContainer;
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

/** Postgres migrated by the image's own pre-deploy command, `count` replicas, and the gateway in front. */
export async function startStack(count = 3, { env = {}, freeNodes }: StackOptions = {}): Promise<Stack> {
  const network = await new Network().start();
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withNetwork(network)
    .withNetworkAliases('id-postgres')
    .withDatabase('ids')
    .withUsername('ids')
    .withPassword('ids')
    .start();
  await new GenericContainer(ID_SERVICE_IMAGE)
    .withNetwork(network)
    .withEnvironment({ DATABASE_URL })
    .withCommand(['node', 'dist/database/migrate-cli.js'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();
  if (freeNodes !== undefined) await reserveNodesAbove(postgres, freeNodes);

  const replicas = await startReplicas(network, count, env);
  const gateway = await new GenericContainer(GATEWAY_IMAGE)
    .withNetwork(network)
    .withEnvironment({ ID_LB_PORT: String(LB_PORT), ID_SERVICE_HOST: ID_SERVICE_ALIAS, ID_SERVICE_PORT: '3000' })
    .withExposedPorts(8080, LB_PORT)
    .withWaitStrategy(Wait.forHttp('/health', 8080))
    .start();
  const lbUrl = `http://${gateway.getHost()}:${gateway.getMappedPort(LB_PORT)}`;
  return { network, postgres, gateway, replicas, lbUrl };
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
          DATABASE_URL,
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

async function reserveNodesAbove(postgres: StartedPostgreSqlContainer, freeNodes: number): Promise<void> {
  const client = new Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  try {
    await client.query(`UPDATE node_leases SET holder = 'reserved', lease_until = 'infinity' WHERE node_id > $1`, [
      freeNodes,
    ]);
  } finally {
    await client.end();
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
  await stack.postgres.stop();
  await stack.network.stop();
}

export interface MintRun {
  ids: string[];
  failures: { status: number; body: string }[];
  maxLatencyMs: number;
}

/** `workers` callers minting batches through the load balancer until `until` resolves. */
export async function mintUntil(lbUrl: string, until: Promise<unknown>, workers = 8, count = 100): Promise<MintRun> {
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
    body: JSON.stringify({ bucket: 7, count }),
  });
  run.maxLatencyMs = Math.max(run.maxLatencyMs, Date.now() - startedAt);
  if (res.status !== 200) {
    run.failures.push({ status: res.status, body: await res.text() });
    return;
  }
  run.ids.push(...((await res.json()) as { ids: string[] }).ids);
}

/** Ids and (timestamp, node, sequence) triples seen more than once, and the nodes that minted. */
export function collisions(ids: string[]): { duplicateIds: number; duplicateTriples: number; nodes: Set<number> } {
  const triples = new Set<string>();
  const nodes = new Set<number>();
  let duplicateTriples = 0;
  for (const id of ids) {
    const { tsMs, nodeId, sequence } = decode(id);
    nodes.add(nodeId);
    const triple = `${tsMs}:${nodeId}:${sequence}`;
    if (triples.has(triple)) duplicateTriples += 1;
    triples.add(triple);
  }
  return { duplicateIds: ids.length - new Set(ids).size, duplicateTriples, nodes };
}
