import { resolve } from 'node:path';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const GATEWAY_IMAGE = 'jcool-gateway:system-test';
const ID_SERVICE_ALIAS = 'id-service';
const ID_SERVICE_PORT = 3000;
const LB_PORT = 4000;
const PUBLIC_PORT = 8080;
const REQUESTS = 30;

type Mode = 'ok' | '503' | 'hang';

interface Answer {
  status: number;
  replica?: string;
  ms: number;
}

const failed = (answers: Answer[]) => answers.filter((answer) => answer.status !== 200);

// Three fake replicas behind one network alias, as the real ones sit behind one private DNS name.
describe('gateway: internal load balancer over id-service', () => {
  let network: StartedNetwork;
  let replicas: StartedTestContainer[];
  let gateway: StartedTestContainer;

  beforeAll(async () => {
    await GenericContainer.fromDockerfile(resolve(__dirname, '..')).build(GATEWAY_IMAGE, { deleteOnExit: false });
  });

  beforeEach(async () => {
    network = await new Network().start();
    replicas = await Promise.all(
      [1, 2, 3].map(() =>
        new GenericContainer('node:24-alpine')
          .withNetwork(network)
          .withNetworkAliases(ID_SERVICE_ALIAS)
          .withCopyFilesToContainer([
            { source: resolve(__dirname, 'fixtures/fake-id-service.cjs'), target: '/fake-id-service.cjs' },
          ])
          .withCommand(['node', '/fake-id-service.cjs'])
          .withExposedPorts(ID_SERVICE_PORT)
          .withWaitStrategy(Wait.forListeningPorts())
          .start(),
      ),
    );
    gateway = await new GenericContainer(GATEWAY_IMAGE)
      .withNetwork(network)
      .withEnvironment({
        PORT: String(PUBLIC_PORT),
        ID_LB_PORT: String(LB_PORT),
        ID_SERVICE_HOST: ID_SERVICE_ALIAS,
        ID_SERVICE_PORT: String(ID_SERVICE_PORT),
        // Outlasts every run of requests below, so a replica seen once was seen once because it sat out.
        ID_LB_FAIL_DURATION: '30s',
      })
      .withExposedPorts(PUBLIC_PORT, LB_PORT)
      .withWaitStrategy(Wait.forHttp('/health', PUBLIC_PORT))
      .start();
  });

  afterEach(async () => {
    await Promise.allSettled([gateway?.stop(), ...(replicas ?? []).map((replica) => replica.stop())]);
    await network?.stop();
  });

  const url = (port: number, path: string) => `http://${gateway.getHost()}:${gateway.getMappedPort(port)}${path}`;
  const replicaName = (replica: StartedTestContainer) => replica.getId().slice(0, 12);

  const control = (replica: StartedTestContainer, path: string) =>
    `http://${replica.getHost()}:${replica.getMappedPort(ID_SERVICE_PORT)}${path}`;

  async function setMode(replica: StartedTestContainer, mode: Mode): Promise<void> {
    const res = await fetch(control(replica, `/__mode/${mode}`), { method: 'POST' });
    expect(res.status).toBe(200);
  }

  async function hits(replica: StartedTestContainer): Promise<number> {
    return Number(await (await fetch(control(replica, '/__hits'))).text());
  }

  async function mint(): Promise<Answer> {
    const startedAt = Date.now();
    const res = await fetch(url(LB_PORT, '/v1/ids'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 0 }),
    });
    const body = (await res.json().catch(() => ({}))) as { replica?: string };
    return { status: res.status, replica: body.replica, ms: Date.now() - startedAt };
  }

  async function mintMany(count = REQUESTS): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (let i = 0; i < count; i += 1) answers.push(await mint());
    return answers;
  }

  it('spreads requests over every replica', async () => {
    const answers = await mintMany();

    expect(failed(answers)).toEqual([]);
    expect(new Set(answers.map((answer) => answer.replica))).toEqual(new Set(replicas.map(replicaName)));
  });

  it('retries a mint a replica refused with 503 on another one, then keeps that replica out', async () => {
    const [unleased] = replicas;
    await setMode(unleased, '503');

    const answers = await mintMany();

    expect(failed(answers)).toEqual([]);
    expect(await hits(unleased)).toBe(1);
  });

  it('answers 503 once every replica refuses', async () => {
    await Promise.all(replicas.map((replica) => setMode(replica, '503')));

    const answers = await mintMany(5);

    expect(answers.map((answer) => answer.status)).toEqual([503, 503, 503, 503, 503]);
  });

  it('retries a mint that a hung replica never answers, within the try deadline', async () => {
    const [hung] = replicas;
    await setMode(hung, 'hang');

    const answers = await mintMany();

    expect(failed(answers)).toEqual([]);
    expect(answers.map((answer) => answer.replica)).not.toContain(replicaName(hung));
    expect(Math.max(...answers.map((answer) => answer.ms))).toBeLessThan(1_000);
  });

  it('retries past a replica that was killed while still listed in DNS', async () => {
    const [killed] = replicas;
    await killed.stop({ timeout: 0 });

    const answers = await mintMany();

    expect(failed(answers)).toEqual([]);
  });

  it('keeps the load balancer off the public listener', async () => {
    const health = await fetch(url(PUBLIC_PORT, '/health'));
    expect(health.status).toBe(200);

    const mintViaPublic = await fetch(url(PUBLIC_PORT, '/v1/ids'), { method: 'POST', body: '{"bucket":0}' });
    expect(mintViaPublic.status).toBe(404);
  });
});
