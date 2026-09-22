import { randomBytes } from 'node:crypto';
import { GenericContainer, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGatewayImage,
  fixtureUrl,
  gatewayContainer,
  PUBLIC_PORT,
  REPO_ROOT,
  startDualStackNetwork,
  startFixture,
  urlOf,
} from './gateway-stack';

const API_IMAGE = 'jcool-api:system-test';
const API_PORT = 3000;
const ALLOWED_ORIGIN = 'https://shop.system-test.invalid';

const API_ENV = {
  DATABASE_URL: 'postgres://api:api@postgres:5432/api',
  REDIS_URL: 'redis://redis:6379',
  // Nothing listens there: the api boots and refuses every token, which is all these cases need.
  AUTH_JWKS_URL: 'http://user-service.invalid/.well-known/jwks.json',
  JWT_ISSUER: 'https://auth.system-test.invalid',
  JWT_AUDIENCE: 'jcool-system-test',
  USER_SERVICE_INTERNAL_URL: 'http://user-service.invalid',
  INTERNAL_API_TOKEN: randomBytes(32).toString('hex'),
  PAYMENT_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  SMTP_URL: 'smtp://smtp.invalid:587',
  MAIL_FROM: 'system-test@example.invalid',
  STORAGE_ENDPOINT: 'http://storage.invalid:9000',
  STORAGE_BUCKET: 'system-test',
  STORAGE_ACCESS_KEY_ID: 'system-test',
  STORAGE_SECRET_ACCESS_KEY: randomBytes(16).toString('hex'),
  LOG_LEVEL: 'warn',
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// The api's contract through the gateway, request by request, against the same api called directly.
const SAMPLES: { name: string; path: string; init?: RequestInit }[] = [
  { name: 'readiness', path: '/health/ready' },
  { name: 'the public catalog', path: '/products' },
  { name: 'a product that does not exist', path: '/products/does-not-exist' },
  { name: 'an unknown route', path: '/nope' },
  { name: 'a route auth has moved away from', path: '/auth/me' },
  { name: 'an admin route without a token', path: '/admin/orders' },
  {
    name: 'a webhook with a bad signature',
    path: '/webhooks/payment',
    init: { ...json({ id: 'evt_1' }), headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=0' } },
  },
  {
    name: 'a CORS preflight from the allowed origin',
    path: '/orders',
    init: {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    },
  },
];

// Framing and connection headers belong to each hop: Go, for one, never sends Content-Length on a 204.
const DROPPED = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date']);
// Different on every response by design.
const VOLATILE = /^(etag|x-request-id|x-ratelimit-(remaining|reset)(-\w+)?)$/;

const contract = (res: Response) =>
  Object.fromEntries(
    [...res.headers]
      .filter(([name]) => !DROPPED.has(name))
      .map(([name, value]) => [name, VOLATILE.test(name) ? '*' : value]),
  );

describe('gateway: the api behind it', () => {
  let network: StartedNetwork;
  let containers: StartedTestContainer[] = [];
  let api: StartedTestContainer;
  let edge: StartedTestContainer;
  let gateway: StartedTestContainer;

  beforeAll(async () => {
    await Promise.all([
      buildGatewayImage(),
      GenericContainer.fromDockerfile(REPO_ROOT).build(API_IMAGE, { deleteOnExit: false }),
    ]);
    let containerRange: string;
    ({ network, containerRange } = await startDualStackNetwork());
    const [postgres, redis] = await Promise.all([
      new GenericContainer('postgres:16-alpine')
        .withNetwork(network)
        .withNetworkAliases('postgres')
        .withEnvironment({ POSTGRES_USER: 'api', POSTGRES_PASSWORD: 'api', POSTGRES_DB: 'api' })
        // The init server logs it once before restarting on TCP.
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
      new GenericContainer('redis:7-alpine')
        .withNetwork(network)
        .withNetworkAliases('redis')
        // The api refuses to boot against a Redis that can lose session epochs or the denylist.
        .withCommand(['redis-server', '--appendonly', 'yes'])
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);
    edge = await startFixture(network, 'fake-edge.cjs', 'edge', { UPSTREAM: 'gateway:8080' });
    containers = [postgres, redis, edge];

    await new GenericContainer(API_IMAGE)
      .withNetwork(network)
      .withEnvironment(API_ENV)
      .withCommand(['npm', 'run', 'db:migrate:prod'])
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(120_000)
      .start();
    api = await new GenericContainer(API_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('api')
      .withEnvironment({
        ...API_ENV,
        PORT: String(API_PORT),
        // The containers' IPv6 range, as production trusts fd12::/16: a hop count would trust any peer.
        TRUST_PROXY: containerRange,
        SWAGGER_ENABLED: 'true',
        CORS_ORIGINS: ALLOWED_ORIGIN,
      })
      .withExposedPorts(API_PORT)
      .withWaitStrategy(Wait.forHttp('/health/ready', API_PORT))
      .withStartupTimeout(120_000)
      .start();
    containers.push(api);
    gateway = await gatewayContainer(network, {
      // Railway's value: without tcp6/ the gateway dials IPv4 and the api believes none of it.
      API_UPSTREAM: `tcp6/api:${API_PORT}`,
      TRUSTED_PROXY_CIDRS: `${edge.getIpAddress(network.getName())}/32`,
    })
      .withNetworkAliases('gateway')
      .withWaitStrategy(Wait.forHttp('/health/ready', PUBLIC_PORT))
      .start();
    containers.push(gateway);
  });

  afterAll(async () => {
    await Promise.allSettled(containers.map((container) => container.stop()));
    await network?.stop();
  });

  const direct = (path: string, init?: RequestInit) => fetch(urlOf(api, API_PORT, path), init);
  const proxied = (path: string, init?: RequestInit) => fetch(urlOf(gateway, PUBLIC_PORT, path), init);

  it('serves the same OpenAPI document', async () => {
    const [straight, through] = await Promise.all([direct('/docs-json'), proxied('/docs-json')]);

    expect(through.status).toBe(200);
    expect(await through.json()).toEqual(await straight.json());
  });

  it.each(SAMPLES)('answers $name with the same status and headers', async ({ path, init }) => {
    const straight = await direct(path, init);
    const through = await proxied(path, init);

    expect(through.status).toBe(straight.status);
    expect(contract(through)).toEqual(contract(straight));
  });

  it('keys the IP throttle on the address the edge saw, whatever the client claims', async () => {
    const remaining = async (client: string, headers: Record<string, string> = {}) => {
      const res = await fetch(fixtureUrl(edge, '/products'), { headers: { ...headers, 'x-test-client-ip': client } });
      expect(res.status).toBe(200);
      return Number(res.headers.get('x-ratelimit-remaining'));
    };

    const first = await remaining('198.51.100.21');
    expect(await remaining('198.51.100.21')).toBe(first - 1);
    expect(await remaining('198.51.100.22')).toBe(first);
    expect(await remaining('198.51.100.21', { 'x-forwarded-for': '198.51.100.22', 'x-real-ip': '198.51.100.22' })).toBe(
      first - 2,
    );
  });

  it('takes no forwarding header from a peer that is not the gateway', async () => {
    const remaining = async (claimed: string) => {
      const res = await direct('/products', { headers: { 'x-forwarded-for': claimed } });
      expect(res.status).toBe(200);
      return Number(res.headers.get('x-ratelimit-remaining'));
    };

    const first = await remaining('198.51.100.31');
    expect(await remaining('198.51.100.32')).toBe(first - 1);
  });
});
