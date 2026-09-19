import { request } from 'node:http';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGatewayImage,
  fixtureUrl,
  GATEWAY_IMAGE,
  gatewayContainer,
  hits,
  PUBLIC_PORT,
  startFixture,
  startGateway,
  urlOf,
} from './gateway-stack';

interface Echo {
  upstream: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const CLIENT = '198.51.100.7';
const FORGED = '203.0.113.9';
const FORGED_HEADERS = { 'x-forwarded-for': FORGED, 'x-real-ip': FORGED };
// Per connection or per body, so never part of what the api promised.
const NOT_CONTRACT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'date', 'content-length', 'set-cookie']);

// Sent raw: fetch would resolve the dot segments before the gateway ever saw them.
const INTERNAL_PATHS = [
  '/internal',
  '/internal/v1/users/x',
  '/Internal/v1/users/x',
  '/%69nternal/v1/users/x',
  '//internal/v1/users/x',
  '/internal/../internal/v1/users/x',
  '/internal%2Fv1/users/x',
];

const contractHeaders = (res: Response) =>
  Object.fromEntries([...res.headers].filter(([name]) => !NOT_CONTRACT.has(name)));

const echoOf = async (res: Promise<Response>) => (await (await res).json()) as Echo;

// Fake upstreams stand in for the api and a future auth service; a fake edge stands in for Railway's.
describe('gateway: public site', () => {
  let network: StartedNetwork;
  let api: StartedTestContainer;
  let auth: StartedTestContainer;
  let idService: StartedTestContainer;
  let edge: StartedTestContainer;
  let gateway: StartedTestContainer;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    await buildGatewayImage();
    network = await new Network().start();
    [api, auth, idService, edge] = await Promise.all([
      startFixture(network, 'fake-upstream.cjs', 'api', { NAME: 'api' }),
      startFixture(network, 'fake-upstream.cjs', 'auth', { NAME: 'auth' }),
      startFixture(network, 'fake-id-service.cjs', 'id-service'),
      startFixture(network, 'fake-edge.cjs', 'edge', { UPSTREAM: 'gateway:8080' }),
    ]);
    baseEnv = {
      API_UPSTREAM: 'api:3000',
      ID_SERVICE_HOST: 'id-service',
      ID_SERVICE_PORT: '3000',
      TRUSTED_PROXY_CIDRS: `${edge.getIpAddress(network.getName())}/32`,
    };
    gateway = await gatewayContainer(network, baseEnv)
      .withNetworkAliases('gateway')
      .withWaitStrategy(Wait.forHttp('/health/live', PUBLIC_PORT))
      .start();
  });

  afterAll(async () => {
    await Promise.allSettled([gateway, api, auth, idService, edge].map((container) => container?.stop()));
    await network?.stop();
  });

  const direct = (path: string, init?: RequestInit, target = gateway) => fetch(urlOf(target, PUBLIC_PORT, path), init);

  const viaEdge = (path: string, client: string, init: RequestInit = {}) =>
    fetch(fixtureUrl(edge, path), { ...init, headers: { ...init.headers, 'x-test-client-ip': client } });

  function rawStatus(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      request({ host: gateway.getHost(), port: gateway.getMappedPort(PUBLIC_PORT), path }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
  }

  it('passes a request to the api byte for byte', async () => {
    const body = Buffer.from('{"id":"evt_1",  "amount": 1250}\n');

    const echo = await echoOf(
      direct('/webhooks/payment?attempt=2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
        body,
      }),
    );

    expect(echo).toMatchObject({
      upstream: 'api',
      method: 'POST',
      url: '/webhooks/payment?attempt=2',
      body: body.toString('base64'),
    });
    expect(echo.headers['stripe-signature']).toBe('t=1,v1=abc');
  });

  it("hands the api's response back without adding or changing a header", async () => {
    const [proxied, straight] = await Promise.all([direct('/products'), fetch(fixtureUrl(api, '/products'))]);

    expect(proxied.status).toBe(straight.status);
    expect(proxied.headers.getSetCookie()).toEqual(straight.headers.getSetCookie());
    expect(contractHeaders(proxied)).toEqual(contractHeaders(straight));
  });

  it('never lets /internal through, however the path is spelled', async () => {
    const before = await hits(api);

    for (const path of INTERNAL_PATHS) expect(await rawStatus(path), path).toBe(404);
    expect(await hits(api)).toBe(before);
  });

  it('never reaches the id-service load balancer from the public listener', async () => {
    const echo = await echoOf(
      direct('/v1/ids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"bucket":0}' }),
    );

    expect(echo.upstream).toBe('api');
    expect(await hits(idService)).toBe(0);
  });

  it('answers /health/live itself and hands /health/ready to the api', async () => {
    const before = await hits(api);

    expect((await direct('/health/live')).status).toBe(200);
    expect(await hits(api)).toBe(before);
    expect((await echoOf(direct('/health/ready'))).upstream).toBe('api');
  });

  describe('client address', () => {
    it('tells the api the address the edge saw, as the only hop', async () => {
      const echo = await echoOf(viaEdge('/products', CLIENT));

      expect(echo.headers['x-forwarded-for']).toBe(CLIENT);
      expect(echo.headers['x-real-ip']).toBe(CLIENT);
    });

    it('ignores the addresses a client writes into its own headers', async () => {
      const echo = await echoOf(viaEdge('/products', CLIENT, { headers: FORGED_HEADERS }));

      expect(echo.headers['x-forwarded-for']).toBe(CLIENT);
      expect(echo.headers['x-real-ip']).toBe(CLIENT);
    });

    it('takes no address header from a peer that is not the edge', async () => {
      const echo = await echoOf(direct('/products', { headers: FORGED_HEADERS }));

      expect(echo.headers['x-forwarded-for']).not.toContain(FORGED);
      expect(echo.headers['x-forwarded-for'].split(',')).toHaveLength(1);
      expect(echo.headers['x-real-ip']).toBe(echo.headers['x-forwarded-for']);
    });
  });

  describe('auth routes', () => {
    it('go to the api while AUTH_UPSTREAM is unset', async () => {
      expect((await echoOf(direct('/auth/login', { method: 'POST' }))).upstream).toBe('api');
    });

    it('go to AUTH_UPSTREAM once it is set, and nothing else does', async () => {
      const flipped = await startGateway(network, { ...baseEnv, AUTH_UPSTREAM: 'auth:3000' });
      const upstreamOf = async (path: string) => (await echoOf(direct(path, undefined, flipped))).upstream;
      try {
        for (const path of ['/auth', '/auth/login', '/.well-known/jwks.json']) {
          expect(await upstreamOf(path), path).toBe('auth');
        }
        for (const path of ['/authx', '/products', '/.well-known/openid-configuration']) {
          expect(await upstreamOf(path), path).toBe('api');
        }
      } finally {
        await flipped.stop();
      }
    });
  });

  describe('startup', () => {
    // A container that exits non-zero fails "to start"; one that keeps running would time out instead.
    // No published ports: those would be waited on first, and never bound.
    const exitsWith = (env: Record<string, string>) =>
      new GenericContainer(GATEWAY_IMAGE)
        .withNetwork(network)
        .withEnvironment(env)
        .withWaitStrategy(Wait.forOneShotStartup())
        .withStartupTimeout(20_000)
        .start();

    it('refuses to start without API_UPSTREAM', async () => {
      const { API_UPSTREAM: _missing, ...env } = baseEnv;

      await expect(exitsWith(env)).rejects.toThrow(/failed to start/);
    });

    it('refuses to start when AUTH_UPSTREAM is required but unset', async () => {
      await expect(exitsWith({ ...baseEnv, AUTH_UPSTREAM_REQUIRED: 'true' })).rejects.toThrow(/failed to start/);
    });

    it('starts when a required AUTH_UPSTREAM is set', async () => {
      const started = await startGateway(network, {
        ...baseEnv,
        AUTH_UPSTREAM_REQUIRED: 'true',
        AUTH_UPSTREAM: 'auth:3000',
      });
      await started.stop();
    });
  });

  it('keeps tokens and credentials out of the access log', async () => {
    await direct('/auth/verify-email?token=leaked-token&lang=vi', {
      headers: { authorization: 'Bearer leaked-bearer', cookie: 'refresh=leaked-cookie' },
    });

    const logs = await new Promise<string>((resolve, reject) => {
      let text = '';
      void gateway.logs().then((stream) => {
        stream.on('data', (chunk: Buffer | string) => (text += chunk.toString()));
        stream.on('error', reject);
        setTimeout(() => {
          stream.destroy();
          resolve(text);
        }, 1_000);
      }, reject);
    });

    expect(logs).toContain('/auth/verify-email?lang=vi');
    expect(logs).not.toMatch(/leaked-(token|bearer|cookie)/);
  });
});
