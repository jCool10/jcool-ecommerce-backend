import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { decodeProtectedHeader } from 'jose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import {
  API_ENV,
  API_IMAGE,
  APP_PORT,
  appUrl,
  type AuthServicesStack,
  buildImages,
  GATEWAY_PORT,
  IDENTITY_BUCKET_KEY,
  JWT_AUDIENCE,
  JWT_ISSUER,
  PG_PORT,
  REDIS_PORT,
  replaceContainer,
  startApp,
  startGateway,
  startStack,
  stopStack,
  USER_SERVICE_ENV,
  USER_SERVICE_IMAGE,
} from './auth-services-stack';

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = resolve(__dirname, '../..');
const COPY_SCRIPT = resolve(PACKAGE_ROOT, 'scripts/cutover/copy-user-tables.sh');
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'cutover@system-test.invalid';
const SCRIPT_TIMEOUT_MS = 120_000;
// The services reach Redis by name; the operator scripts reach the same logical db from the host.
const REDIS_DB = new URL(USER_SERVICE_ENV.REDIS_URL).pathname;

/** Keeps the refresh and CSRF cookies of one browser, since the auth routes are a double-submit pair. */
class Cookies {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): Response {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      this.jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }

  headers(): Record<string, string> {
    return {
      cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '),
      'x-csrf-token': this.jar.get('csrf_token') ?? '',
    };
  }
}

/**
 * The cutover itself, in the order the runbook takes it: freeze, copy, prewarm, then the api, the
 * gateway and the api again. What the order buys is that no token is ever presented to something
 * that cannot verify it, which is asserted at the one moment it could go wrong.
 */
describe('cutover: the flip', () => {
  let stack: AuthServicesStack;
  let api: string;
  let userService: string;
  let gateway: string;
  let redis: Redis;
  let scriptEnv: Record<string, string>;
  let userId: string;
  let hs256Token: string;
  let es256Token: string;
  const preCutover = new Cookies();

  beforeAll(async () => {
    await buildImages();
    stack = await startStack([{ source: COPY_SCRIPT, target: '/copy-user-tables.sh', mode: 0o755 }]);
    api = appUrl(stack.api);
    userService = appUrl(stack.userService);
    gateway = `http://${stack.gateway.getHost()}:${stack.gateway.getMappedPort(GATEWAY_PORT)}`;

    const redisUrl = `redis://${stack.redis.getHost()}:${stack.redis.getMappedPort(REDIS_PORT)}${REDIS_DB}`;
    redis = new Redis(redisUrl);
    scriptEnv = {
      API_DATABASE_URL: hostUrl(stack.apiPostgres, 'api'),
      USER_DATABASE_URL: hostUrl(stack.userPostgres, 'users'),
      REDIS_URL: redisUrl,
      IDENTITY_BUCKET_KEY,
    };
  }, 900_000);

  afterAll(async () => {
    await redis?.quit();
    await stopStack(stack);
  });

  const hostUrl = (container: AuthServicesStack['apiPostgres'], name: string) =>
    `postgres://${name}:${name}@${container.getHost()}:${container.getMappedPort(PG_PORT)}/${name}`;

  const post = (base: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.18.0.7', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const get = (base: string, path: string, token: string) =>
    fetch(base + path, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.18.0.7' } });

  async function runScript(script: string, args: string[] = []): Promise<string> {
    const { stdout } = await execFileAsync(`${PACKAGE_ROOT}/node_modules/.bin/tsx`, [script, ...args], {
      cwd: PACKAGE_ROOT,
      timeout: SCRIPT_TIMEOUT_MS,
      env: { ...process.env, ...scriptEnv },
    });
    return stdout;
  }

  async function runCopy(...args: string[]): Promise<void> {
    const { exitCode, output } = await stack.userPostgres.exec([
      'sh',
      '-c',
      `API_DATABASE_URL='postgres://api:api@api-postgres:5432/api' ` +
        `USER_DATABASE_URL='postgres://users:users@user-postgres:5432/users' ` +
        `sh /copy-user-tables.sh ${args.join(' ')}`,
    ]);
    if (exitCode !== 0) throw new Error(`copy-user-tables.sh exited ${exitCode}\n${output}`);
  }

  it('starts with the api serving auth and signing HS256', async () => {
    const registered = await post(gateway, '/auth/register', { email: EMAIL, password: PASSWORD });
    expect(registered.status).toBe(201);
    userId = ((await registered.json()) as { id: string }).id;

    const login = preCutover.absorb(await post(gateway, '/auth/login', { email: EMAIL, password: PASSWORD }));
    ({ accessToken: hs256Token } = (await login.json()) as { accessToken: string });

    expect(login.status).toBe(200);
    expect(decodeProtectedHeader(hs256Token).alg).toBe('HS256');
    expect((await get(gateway, '/cart', hs256Token)).status).toBe(200);
  });

  it('freezes the writes without taking the reads down', async () => {
    stack.gateway = await replaceContainer(stack, stack.gateway, () =>
      startGateway(stack.network, { AUTH_WRITE_FREEZE: 'true' }),
    );
    gateway = `http://${stack.gateway.getHost()}:${stack.gateway.getMappedPort(GATEWAY_PORT)}`;

    const frozen = await post(gateway, '/auth/login', { email: EMAIL, password: PASSWORD });

    expect(frozen.status).toBe(503);
    expect(frozen.headers.get('retry-after')).toBeTruthy();
    expect((await get(gateway, '/auth/me', hs256Token)).status).toBe(200);
  });

  it('copies the user tables and prewarms every epoch', async () => {
    await runCopy();

    expect(await runScript('scripts/cutover/verify-copy.ts')).toContain('Verification passed.');
    expect(await runScript('scripts/cutover/prewarm-epochs.ts')).toContain('Prewarmed 1 epochs.');
    expect(await runScript('scripts/cutover/verify-copy.ts', ['--epochs'])).toContain('Verification passed.');
  });

  // The boot verifier only ever sees the rows that are there: on an empty database it has nothing to
  // check, so the restart happens here, while writes are still frozen and a refusal costs nothing.
  it('restarts the user-service so its key is checked against the copied rows', async () => {
    stack.userService = await replaceContainer(stack, stack.userService, () =>
      startApp(stack.network, USER_SERVICE_IMAGE, 'user-service', USER_SERVICE_ENV),
    );
    userService = appUrl(stack.userService);

    expect((await fetch(`${userService}/health/ready`)).status).toBe(200);
  });

  it('will not let the api verify a user-service token before it is redeployed', async () => {
    const login = await post(userService, '/auth/login', { email: EMAIL, password: PASSWORD });
    ({ accessToken: es256Token } = (await login.json()) as { accessToken: string });

    expect(decodeProtectedHeader(es256Token).alg).toBe('ES256');
    expect((await get(api, '/cart', es256Token)).status).toBe(401);
  });

  it('9a: the api takes user-service tokens, and reads what it lacks from the service', async () => {
    stack.api = await replaceContainer(stack, stack.api, () =>
      startApp(stack.network, API_IMAGE, 'api', {
        ...API_ENV,
        REDIS_URL: USER_SERVICE_ENV.REDIS_URL,
        AUTH_EPOCH_SOURCE: 'redis',
        USER_DIRECTORY_SOURCE: 'remote',
        AUTH_JWKS_URL: `http://user-service:${APP_PORT}/.well-known/jwks.json`,
        USER_SERVICE_INTERNAL_URL: `http://user-service:${APP_PORT}`,
        INTERNAL_API_TOKEN: USER_SERVICE_ENV.INTERNAL_API_TOKEN,
        JWT_ISSUER,
        JWT_AUDIENCE,
      }),
    );
    api = appUrl(stack.api);

    expect((await get(api, '/cart', es256Token)).status).toBe(200);

    await redis.del(SESSION_EPOCH_KEY_PREFIX + userId);
    expect((await get(api, '/cart', es256Token)).status).toBe(200);
    expect(await redis.get(SESSION_EPOCH_KEY_PREFIX + userId)).toBe('0');
  });

  it('9b: the gateway sends auth to the user-service, and the old cookies still work', async () => {
    stack.gateway = await replaceContainer(stack, stack.gateway, () =>
      startGateway(stack.network, { AUTH_UPSTREAM: `user-service:${APP_PORT}`, AUTH_UPSTREAM_REQUIRED: 'true' }),
    );
    gateway = `http://${stack.gateway.getHost()}:${stack.gateway.getMappedPort(GATEWAY_PORT)}`;

    const refreshed = preCutover.absorb(await post(gateway, '/auth/refresh', undefined, preCutover.headers()));
    const { accessToken } = (await refreshed.json()) as { accessToken: string };

    expect(refreshed.status).toBe(200);
    expect(decodeProtectedHeader(accessToken).alg).toBe('ES256');
    expect((await get(api, '/cart', accessToken)).status).toBe(200);
  });

  it('9c: the api stops answering auth at all', async () => {
    stack.api = await replaceContainer(stack, stack.api, () =>
      startApp(stack.network, API_IMAGE, 'api', {
        ...API_ENV,
        REDIS_URL: USER_SERVICE_ENV.REDIS_URL,
        AUTH_EPOCH_SOURCE: 'redis',
        USER_DIRECTORY_SOURCE: 'remote',
        AUTH_ROUTES_ENABLED: 'false',
        AUTH_JWKS_URL: `http://user-service:${APP_PORT}/.well-known/jwks.json`,
        USER_SERVICE_INTERNAL_URL: `http://user-service:${APP_PORT}`,
        INTERNAL_API_TOKEN: USER_SERVICE_ENV.INTERNAL_API_TOKEN,
        JWT_ISSUER,
        JWT_AUDIENCE,
      }),
    );
    api = appUrl(stack.api);

    expect((await post(api, '/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(410);
    expect((await post(gateway, '/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('revokes on the api the moment the user-service says so', async () => {
    const session = new Cookies();
    const login = session.absorb(await post(gateway, '/auth/login', { email: EMAIL, password: PASSWORD }));
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    expect((await get(api, '/cart', token)).status).toBe(200);

    const loggedOut = await post(gateway, '/auth/logout-all', undefined, {
      ...session.headers(),
      authorization: `Bearer ${token}`,
    });

    expect(loggedOut.status).toBe(204);
    expect((await get(api, '/cart', token)).status).toBe(401);
  });

  it('gives each service only its own database', async () => {
    const envOf = async (container: AuthServicesStack['api']) => (await container.exec(['env'])).output;

    expect(await envOf(stack.api)).not.toContain('user-postgres');
    expect(await envOf(stack.userService)).not.toContain('api-postgres');
    expect(await envOf(stack.idService)).toContain('id-postgres');
  });
});
