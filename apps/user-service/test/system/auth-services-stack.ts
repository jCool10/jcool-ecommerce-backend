import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';

const REPO_ROOT = resolve(__dirname, '../../../..');
export const API_IMAGE = 'jcool-api:system-test';
export const USER_SERVICE_IMAGE = 'jcool-user-service:system-test';
const ID_SERVICE_IMAGE = 'jcool-id-service:system-test';
const GATEWAY_IMAGE = 'jcool-gateway:system-test';
export const APP_PORT = 3000;
export const GATEWAY_PORT = 8080;
export const PG_PORT = 5432;
export const REDIS_PORT = 6379;
const LB_PORT = 4000;
const STARTUP_TIMEOUT_MS = 120_000;

/** testcontainers keeps its own name for this shape internal. */
export interface FileToCopy {
  source: string;
  target: string;
  mode?: number;
}

export const ALLOWED_ORIGIN = 'https://shop.system-test.invalid';
export const IDENTITY_BUCKET_KEY = randomBytes(32).toString('hex');
export const JWT_ISSUER = 'https://auth.system-test.invalid';
export const JWT_AUDIENCE = 'jcool-system-test';

// The user-service takes the api's secret as its CSRF key, so cookies the api issued stay valid.
const API_JWT_SECRET = randomBytes(32).toString('hex');

const SHARED_ENV = {
  IDENTITY_BUCKET_KEY,
  JWT_ACCESS_SECRET: API_JWT_SECRET,
  SMTP_URL: 'smtp://smtp.invalid:587',
  MAIL_FROM: 'system-test@example.invalid',
  APP_PUBLIC_URL: ALLOWED_ORIGIN,
  CORS_ORIGINS: ALLOWED_ORIGIN,
  SWAGGER_ENABLED: 'true',
  // Each request names its client in X-Forwarded-For, so no throttle carries over between tests.
  TRUST_PROXY: '1',
  LOG_LEVEL: 'warn',
  PORT: String(APP_PORT),
};

export const API_ENV = {
  ...SHARED_ENV,
  DATABASE_URL: 'postgres://api:api@api-postgres:5432/api',
  REDIS_URL: 'redis://redis:6379/0',
  PAYMENT_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  STORAGE_ENDPOINT: 'http://storage.invalid:9000',
  STORAGE_BUCKET: 'system-test',
  STORAGE_ACCESS_KEY_ID: 'system-test',
  STORAGE_SECRET_ACCESS_KEY: randomBytes(16).toString('hex'),
};

export const USER_SERVICE_ENV = {
  ...SHARED_ENV,
  DATABASE_URL: 'postgres://users:users@user-postgres:5432/users',
  REDIS_URL: 'redis://redis:6379/1',
  IDENTITY_PIN_BOOTSTRAP: 'true',
  CSRF_SECRET: API_JWT_SECRET,
  JWT_ES256_PRIVATE_KEYS: `system-1:${es256Pem().replace(/\n/g, '\\n')}`,
  JWT_ES256_ACTIVE_KID: 'system-1',
  JWT_ISSUER,
  JWT_AUDIENCE,
  ID_SERVICE_URL: `http://gateway:${LB_PORT}`,
  INTERNAL_API_TOKEN: randomBytes(32).toString('hex'),
};

const ID_SERVICE_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://ids:ids@id-postgres:5432/ids',
  LOG_LEVEL: 'warn',
  SHUTDOWN_GRACE_PERIOD_MS: '0',
};

function es256Pem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export async function buildImages(): Promise<void> {
  const build = (dockerfile: string, tag: string) =>
    GenericContainer.fromDockerfile(REPO_ROOT, dockerfile).build(tag, { deleteOnExit: false });
  await Promise.all([
    build('Dockerfile', API_IMAGE),
    build('apps/user-service/Dockerfile', USER_SERVICE_IMAGE),
    build('apps/id-service/Dockerfile', ID_SERVICE_IMAGE),
    build('apps/gateway/Dockerfile', GATEWAY_IMAGE),
  ]);
}

export interface AuthServicesStack {
  network: StartedNetwork;
  containers: StartedTestContainer[];
  api: StartedTestContainer;
  userService: StartedTestContainer;
  idService: StartedTestContainer;
  gateway: StartedTestContainer;
  apiPostgres: StartedTestContainer;
  userPostgres: StartedTestContainer;
  redis: StartedTestContainer;
}

/**
 * The api and the user-service side by side, sharing one Redis, with the id-service behind the
 * gateway. `files` land in the user-postgres container, which is where psql runs the cutover copy.
 */
export async function startStack(files: FileToCopy[] = []): Promise<AuthServicesStack> {
  const network = await new Network().start();
  const containers: StartedTestContainer[] = [];
  const track = async (pending: Promise<StartedTestContainer>) => {
    const container = await pending;
    containers.push(container);
    return container;
  };

  try {
    const [apiPostgres, userPostgres, , redis] = await Promise.all([
      track(startPostgres(network, 'api-postgres', 'api')),
      track(startPostgres(network, 'user-postgres', 'users', files)),
      track(startPostgres(network, 'id-postgres', 'ids')),
      track(
        new GenericContainer('redis:7-alpine')
          .withNetwork(network)
          .withNetworkAliases('redis')
          .withCommand(['redis-server', '--appendonly', 'yes'])
          .withExposedPorts(REDIS_PORT)
          .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
          .start(),
      ),
    ]);
    await Promise.all([
      migrate(network, API_IMAGE, API_ENV, ['npm', 'run', 'db:migrate:prod']),
      migrate(network, USER_SERVICE_IMAGE, USER_SERVICE_ENV, ['node', 'dist/database/migrate-cli.js']),
      migrate(network, ID_SERVICE_IMAGE, ID_SERVICE_ENV, ['node', 'dist/database/migrate-cli.js']),
    ]);

    const idService = await track(startApp(network, ID_SERVICE_IMAGE, 'id-service', ID_SERVICE_ENV));
    const gateway = await track(startGateway(network, {}));
    const [api, userService] = await Promise.all([
      track(startApp(network, API_IMAGE, 'api', API_ENV)),
      track(startApp(network, USER_SERVICE_IMAGE, 'user-service', USER_SERVICE_ENV)),
    ]);
    return { network, containers, api, userService, idService, gateway, apiPostgres, userPostgres, redis };
  } catch (error) {
    await Promise.allSettled(containers.map((container) => container.stop({ timeout: 0 })));
    await network.stop();
    throw error;
  }
}

export async function stopStack(stack: AuthServicesStack | undefined): Promise<void> {
  if (stack === undefined) return;
  await Promise.allSettled(stack.containers.map((container) => container.stop({ timeout: 0 })));
  await stack.network.stop();
}

export function appUrl(container: StartedTestContainer, path = ''): string {
  return `http://${container.getHost()}:${container.getMappedPort(APP_PORT)}${path}`;
}

function startPostgres(
  network: StartedNetwork,
  alias: string,
  name: string,
  files: FileToCopy[] = [],
): Promise<StartedTestContainer> {
  return (
    new GenericContainer('postgres:16-alpine')
      .withNetwork(network)
      .withNetworkAliases(alias)
      .withEnvironment({ POSTGRES_USER: name, POSTGRES_PASSWORD: name, POSTGRES_DB: name })
      .withExposedPorts(PG_PORT)
      .withCopyFilesToContainer(files)
      // The init server logs it once before restarting on TCP.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
  );
}

/** `env` overrides the defaults, which route everything to the api and put the id LB on the network. */
export function startGateway(network: StartedNetwork, env: Record<string, string>): Promise<StartedTestContainer> {
  return new GenericContainer(GATEWAY_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('gateway')
    .withEnvironment({
      ID_LB_PORT: String(LB_PORT),
      ID_SERVICE_HOST: 'id-service',
      ID_SERVICE_PORT: String(APP_PORT),
      API_UPSTREAM: `api:${APP_PORT}`,
      GATEWAY_SHUTDOWN_DELAY: '0s',
      // Zero would be an endless grace period to Caddy.
      GATEWAY_GRACE_PERIOD: '1ms',
      ...env,
    })
    .withExposedPorts(GATEWAY_PORT)
    .withWaitStrategy(Wait.forHttp('/health/live', GATEWAY_PORT))
    .start();
}

/**
 * A deploy: the old container goes away and a new one takes its network alias. Railway overlaps the
 * two for a while; the cutover's waits exist for exactly that, and are not what this reproduces.
 */
export async function replaceContainer(
  stack: AuthServicesStack,
  previous: StartedTestContainer,
  start: () => Promise<StartedTestContainer>,
): Promise<StartedTestContainer> {
  await previous.stop({ timeout: 0 });
  const replacement = await start();
  const index = stack.containers.indexOf(previous);
  if (index >= 0) stack.containers.splice(index, 1, replacement);
  return replacement;
}

async function migrate(
  network: StartedNetwork,
  image: string,
  env: Record<string, string>,
  command: string[],
): Promise<void> {
  const container = await new GenericContainer(image)
    .withNetwork(network)
    .withEnvironment(env)
    .withCommand(command)
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
  // Ryuk is off in CI, and nothing else would remove an exited one-shot.
  await container.stop();
}

export function startApp(
  network: StartedNetwork,
  image: string,
  alias: string,
  env: Record<string, string>,
): Promise<StartedTestContainer> {
  return new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withEnvironment(env)
    .withExposedPorts(APP_PORT)
    .withWaitStrategy(Wait.forHttp('/health/ready', APP_PORT))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
}
