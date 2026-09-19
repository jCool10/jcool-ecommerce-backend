import { Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGatewayImage, fixtureUrl, hits, LB_PORT, startFixture, startGateway, urlOf } from './gateway-stack';

const ID_SERVICE_ALIAS = 'id-service';
const ID_SERVICE_PORT = 3000;
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

  beforeAll(buildGatewayImage);

  beforeEach(async () => {
    network = await new Network().start();
    replicas = await Promise.all([1, 2, 3].map(() => startFixture(network, 'fake-id-service.cjs', ID_SERVICE_ALIAS)));
    gateway = await startGateway(network, {
      // Never called here: the public site is covered by its own suite.
      API_UPSTREAM: 'api:3000',
      ID_SERVICE_HOST: ID_SERVICE_ALIAS,
      ID_SERVICE_PORT: String(ID_SERVICE_PORT),
      // Outlasts every run of requests below, so a replica seen once was seen once because it sat out.
      ID_LB_FAIL_DURATION: '30s',
    });
  });

  afterEach(async () => {
    await Promise.allSettled([gateway?.stop(), ...(replicas ?? []).map((replica) => replica.stop())]);
    await network?.stop();
  });

  const replicaName = (replica: StartedTestContainer) => replica.getId().slice(0, 12);

  async function setMode(replica: StartedTestContainer, mode: Mode): Promise<void> {
    const res = await fetch(fixtureUrl(replica, `/__mode/${mode}`), { method: 'POST' });
    expect(res.status).toBe(200);
  }

  async function mint(): Promise<Answer> {
    const startedAt = Date.now();
    const res = await fetch(urlOf(gateway, LB_PORT, '/v1/ids'), {
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
});
