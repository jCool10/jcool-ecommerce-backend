import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import {
  buildImages as buildIdServiceAndGatewayImages,
  startIdEtcd,
  startReplicas,
} from '../../../id-service/test/system/replica-set';
import {
  type MetricSample,
  type QueuedJob,
  SagaObserver,
  mailsTo,
  metricSum,
  parseMetrics,
  queueJobs,
} from './checkout-observers';
import {
  type AppService,
  DATABASES,
  type Database,
  databaseUrl,
  PG_USER,
  serviceEnv,
  type StackSecrets,
  stackSecrets,
  TOXIPROXY_PORTS,
} from './checkout-stack-env';
import { FAKE_STRIPE_PORT, FakeStripeControl, startFakeStripe, type StripeFault } from './fake-stripe';
import { startToxiproxy, type Toxic, type Toxiproxy } from './toxiproxy';

const REPO_ROOT = resolve(__dirname, '../../../..');
const APP_PORT = 3000;
const GATEWAY_PORT = 8080;
const TEMPORAL_PORT = 7233;
const GATEWAY_IMAGE = 'jcool-gateway:system-test';

const APP_IMAGES: Record<AppService, { dockerfile: string; tag: string }> = {
  api: { dockerfile: 'Dockerfile', tag: 'jcool-api:system-test' },
  'user-service': { dockerfile: 'apps/user-service/Dockerfile', tag: 'jcool-user-service:system-test' },
  'inventory-service': { dockerfile: 'apps/inventory-service/Dockerfile', tag: 'jcool-inventory-service:system-test' },
  'payment-service': { dockerfile: 'apps/payment-service/Dockerfile', tag: 'jcool-payment-service:system-test' },
  'order-service': { dockerfile: 'apps/order-service/Dockerfile', tag: 'jcool-order-service:system-test' },
};
const TEMPORAL_IMAGE = { dockerfile: 'infra/temporal/Dockerfile', tag: 'jcool-temporal:system-test' };
// Covers the saga worker's longest reconnect backoff (30s plus jitter).
const RESTORE_MS = 60_000;

// Each service's Railway preDeployCommand.
const PRE_DEPLOY: Record<AppService, string[]> = {
  api: ['npm', 'run', 'db:migrate:prod'],
  'user-service': ['node', 'dist/database/migrate-cli.js'],
  'inventory-service': ['node', 'dist/database/pre-deploy-cli.js'],
  'payment-service': ['node', 'dist/database/migrate-cli.js'],
  'order-service': ['node', 'dist/database/migrate-cli.js'],
};

export type ServiceName = AppService | 'gateway' | 'temporal' | 'id-service';

// Dependencies first, so a restored service finds what its readiness checks.
const RESTORE_ORDER: ServiceName[] = [
  'temporal',
  'id-service',
  'user-service',
  'api',
  'gateway',
  'inventory-service',
  'payment-service',
  'order-service',
];

type Env = Record<string, string>;

interface Slot {
  container: StartedTestContainer;
  /** A fresh container of the service, the way a redeploy brings one up. */
  launch: (env: Env) => Promise<StartedTestContainer>;
  env: Env;
  overridden: boolean;
  /** Stopped and removed by a recreate whose launch then failed. */
  removed: boolean;
}

type ProxyName = 'order-to-inventory' | 'order-to-payment' | 'order-to-smtp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- scenarios read whatever shape a route answers
export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Buyer {
  email: string;
  token: string;
  userId: string;
}

export function buildImages(): Promise<unknown> {
  return Promise.all([
    buildIdServiceAndGatewayImages(),
    ...Object.values(APP_IMAGES).map(({ dockerfile, tag }) =>
      GenericContainer.fromDockerfile(REPO_ROOT, dockerfile).build(tag, { deleteOnExit: false }),
    ),
    // COPY --chmod needs BuildKit.
    GenericContainer.fromDockerfile(REPO_ROOT, TEMPORAL_IMAGE.dockerfile)
      .withBuildkit()
      .build(TEMPORAL_IMAGE.tag, { deleteOnExit: false }),
  ]);
}

/** Every service of the checkout in containers on one network, wired as on Railway. */
export class CheckoutStack {
  readonly stripe: FakeStripeControl;
  /** Every variant the public catalog lists, each seeded with stock. */
  skus: string[] = [];
  private readonly env: Record<AppService, Env>;
  private readonly slots = new Map<ServiceName, Slot>();
  private readonly infra: StartedTestContainer[] = [];
  private readonly pools = new Map<Database, Pool>();
  private postgres!: StartedTestContainer;
  private redis!: StartedTestContainer;
  private mailpit!: StartedTestContainer;
  private fakeStripe!: StartedTestContainer;
  private toxiproxy!: Toxiproxy;
  private sagaObserver?: SagaObserver;

  private constructor(
    private readonly network: StartedNetwork,
    readonly secrets: StackSecrets,
  ) {
    this.env = serviceEnv(secrets);
    this.stripe = new FakeStripeControl(() => this.urlOf(this.fakeStripe, FAKE_STRIPE_PORT));
  }

  static async start(): Promise<CheckoutStack> {
    await buildImages();
    const stack = new CheckoutStack(await new Network().start(), stackSecrets());
    try {
      await stack.boot();
    } catch (error) {
      // The boot error is the one worth seeing; Ryuk reaps whatever the stop leaves behind.
      await stack.stop().catch(() => undefined);
      throw error;
    }
    return stack;
  }

  private async boot(): Promise<void> {
    let etcd: StartedTestContainer;
    [this.postgres, this.redis, this.mailpit, etcd] = await Promise.all([
      this.startPostgres(),
      this.startRedis(),
      this.startMailpit(),
      startIdEtcd(this.network),
    ]);
    this.infra.push(this.postgres, this.redis, this.mailpit, etcd);

    await Promise.all([
      this.launch('temporal', this.temporalEnv(), (env) => this.temporalContainer(env).start()),
      this.launch('id-service', { LOG_LEVEL: 'warn' }, async (env) => (await startReplicas(this.network, 1, env))[0]),
      ...(Object.keys(PRE_DEPLOY) as AppService[]).map((app) => this.runOnce(app, PRE_DEPLOY[app])),
    ]);
    await this.runOnce('api', ['node', 'dist/shared/infrastructure/database/seed.js']);
    await Promise.all([this.launchApp('api'), this.launchApp('user-service')]);
    await this.launch('gateway', this.gatewayEnv(), (env) => this.gatewayContainer(env).start());

    await this.runOnce('inventory-service', ['node', 'dist/database/seed-stock.js']);
    this.skus = await this.catalogVariantIds();
    const [{ count }] = await this.sql<{ count: number }>(
      'inventory',
      'select count(*)::int as count from stock_levels',
    );
    if (this.skus.length === 0 || count !== this.skus.length) {
      throw new Error(`stock seed: ${count} stock levels for ${this.skus.length} catalog variants`);
    }

    [this.fakeStripe, this.toxiproxy] = await Promise.all([
      startFakeStripe(this.network, { PAYMENT_WEBHOOK_SECRET: this.secrets.webhookSecret }),
      startToxiproxy(this.network, [
        {
          name: 'order-to-inventory',
          listenPort: TOXIPROXY_PORTS.inventory,
          upstream: `inventory-service:${APP_PORT}`,
        },
        { name: 'order-to-payment', listenPort: TOXIPROXY_PORTS.payment, upstream: `payment-service:${APP_PORT}` },
        { name: 'order-to-smtp', listenPort: TOXIPROXY_PORTS.smtp, upstream: 'mailpit:1025' },
      ]),
    ]);
    this.infra.push(this.fakeStripe, this.toxiproxy.container);
    await this.launchApp('inventory-service');
    await this.launchApp('payment-service');
    await this.launchApp('order-service');
    this.sagaObserver = await SagaObserver.connect(this.address('temporal', TEMPORAL_PORT));
  }

  async stop(): Promise<void> {
    await this.sagaObserver?.close();
    await Promise.allSettled([...this.pools.values()].map((pool) => pool.end()));
    await Promise.allSettled([...this.slots.values()].map(({ container }) => container.stop()));
    await Promise.allSettled(this.infra.map((container) => container.stop()));
    await this.network.stop();
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** SIGKILL: no shutdown hook runs, and the container stays to be started again. */
  async killService(name: ServiceName): Promise<void> {
    const { client, container } = await this.docker(name);
    await client.container.getById(container.getId()).kill({ signal: 'SIGKILL' });
  }

  /** SIGTERM, with the grace Railway gives a draining deployment. */
  async stopService(name: ServiceName, graceMs = 30_000): Promise<void> {
    const { client, container } = await this.docker(name);
    await client.container.stop(client.container.getById(container.getId()), { timeout: graceMs });
  }

  /** The same container again; ports are re-read, since Docker maps new ones on every start. */
  async startService(name: ServiceName): Promise<void> {
    await this.slot(name).container.restart();
    if (name === 'temporal') {
      await this.sagaObserver?.close();
      this.sagaObserver = await SagaObserver.connect(this.address('temporal', TEMPORAL_PORT));
    }
  }

  /** A new container with `overrides` on top of the service's env, ready by its own healthcheck. */
  async recreateService(name: ServiceName, overrides: Env): Promise<void> {
    const slot = this.slot(name);
    if (!slot.removed) await slot.container.stop({ timeout: 30_000 });
    slot.removed = true;
    slot.container = await slot.launch({ ...slot.env, ...overrides });
    slot.removed = false;
    slot.overridden = Object.entries(overrides).some(([key, value]) => slot.env[key] !== value);
  }

  async isRunning(name: ServiceName): Promise<boolean> {
    const { client, container } = await this.docker(name);
    return (await client.container.inspect(client.container.getById(container.getId()))).State.Running;
  }

  /** Back to the stack every scenario starts from: no toxics, a clean fake, every service up. */
  async restore(): Promise<void> {
    await this.toxiproxy.clearToxics();
    await this.stripe.reset();
    for (const name of RESTORE_ORDER) {
      const slot = this.slots.get(name);
      if (slot === undefined) continue;
      if (slot.overridden || slot.removed) await this.recreateService(name, {});
      else if (!(await this.isRunning(name))) await this.startService(name);
    }
    // A scenario that failed midway can leave the saga worker reconnecting; the next must not start on it.
    await waitFor(
      async () => (await this.direct('order-service', 'GET', '/health/ready')).status,
      (status) => status === 200,
      RESTORE_MS,
      'order-service ready',
    );
    await this.waitForSagaWorker();
  }

  /**
   * Temporal answering is not enough: after an outage each poller of the saga worker comes back on
   * its own backoff, and a cancel needs the activity one. Paced, as each scrape spends visibility calls.
   */
  async waitForSagaWorker(): Promise<void> {
    const pollers = (samples: MetricSample[], type: string) =>
      metricSum(samples, 'checkout_saga_task_queue_pollers', (labels) => labels.task_type === type);
    await waitFor(
      async () => {
        const samples = await this.scrapeOrderMetrics();
        return {
          up: metricSum(samples, 'checkout_saga_engine_up'),
          workflow: pollers(samples, 'workflow'),
          activity: pollers(samples, 'activity'),
        };
      },
      ({ up, workflow, activity }) => up === 1 && workflow > 0 && activity > 0,
      RESTORE_MS,
      'saga worker polling',
      1_000,
    );
  }

  addToxic(proxy: ProxyName, toxic: Toxic): Promise<void> {
    return this.toxiproxy.addToxic(proxy, toxic);
  }

  clearToxics(): Promise<void> {
    return this.toxiproxy.clearToxics();
  }

  setStripeFault(fault: StripeFault): Promise<void> {
    return this.stripe.setFault(fault);
  }

  // --- buyers ----------------------------------------------------------------------------------

  /** A new account, signed in, with `quantity` of `skuId` in its cart. */
  async buyer(skuId = this.skus[0], quantity = 1): Promise<Buyer> {
    const email = `buyer-${randomBytes(6).toString('hex')}@system-test.invalid`;
    const password = `pw-${randomBytes(12).toString('hex')}`;
    expectStatus(await this.public('POST', '/auth/register', { body: { email, password } }), 201);
    const login = expectStatus(await this.public('POST', '/auth/login', { body: { email, password } }), 200);
    const token = login.body.accessToken as string;
    const { sub } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string };
    const buyer = { email, token, userId: sub };
    expectStatus(await this.public('POST', '/cart/items', { token: buyer.token, body: { skuId, quantity } }), 200);
    return buyer;
  }

  checkout(buyer: Buyer, idempotencyKey: string = randomUUID()): Promise<HttpResult> {
    return this.public('POST', '/orders', { token: buyer.token, headers: { 'idempotency-key': idempotencyKey } });
  }

  pay(buyer: Buyer, orderId: string): Promise<HttpResult<{ paymentId: string; providerSessionId: string }>> {
    return this.public('POST', `/orders/${orderId}/pay`, { token: buyer.token });
  }

  cancel(buyer: Buyer, orderId: string): Promise<HttpResult> {
    return this.public('POST', `/orders/${orderId}/cancel`, { token: buyer.token });
  }

  authorize(sessionId: string, options: { deliverWebhook: boolean }) {
    return this.stripe.authorize(sessionId, options);
  }

  deliverWebhook(sessionId: string) {
    return this.stripe.deliverWebhook(sessionId);
  }

  /** Through the gateway, as a client sees it. */
  public(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Env } = {},
  ): Promise<HttpResult> {
    return request(method, `${this.url('gateway', GATEWAY_PORT)}${path}`, options);
  }

  /** Straight to a service, past the gateway: how the harness reaches /internal and /metrics. */
  direct(
    name: AppService,
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Env } = {},
  ): Promise<HttpResult> {
    return request(method, `${this.url(name)}${path}`, options);
  }

  // --- probes ----------------------------------------------------------------------------------

  async sql<T = Record<string, unknown>>(db: Database, text: string, params: unknown[] = []): Promise<T[]> {
    let pool = this.pools.get(db);
    if (pool === undefined) {
      pool = new Pool({
        connectionString: databaseUrl(this.secrets, db, this.postgres.getHost(), this.postgres.getMappedPort(5432)),
        max: 2,
      });
      this.pools.set(db, pool);
    }
    return (await pool.query(text, params)).rows as T[];
  }

  async orderStatus(orderId: string): Promise<string | undefined> {
    return (await this.sql<{ status: string }>('orders', 'select status from orders where id = $1', [orderId]))[0]
      ?.status;
  }

  async inventoryHeader(orderId: string): Promise<string | undefined> {
    const rows = await this.sql<{ status: string }>(
      'inventory',
      'select status from reservation_orders where order_id = $1',
      [orderId],
    );
    return rows[0]?.status;
  }

  async paymentHeader(orderId: string): Promise<string | undefined> {
    const rows = await this.sql<{ status: string }>(
      'payment',
      'select status from payment_orders where order_id = $1',
      [orderId],
    );
    return rows[0]?.status;
  }

  waitForOrderStatus(orderId: string, status: string, timeoutMs: number): Promise<unknown> {
    return waitFor(
      () => this.orderStatus(orderId),
      (s) => s === status,
      timeoutMs,
      `order ${orderId} ${status}`,
    );
  }

  waitForInventoryHeader(orderId: string, status: string, timeoutMs = 15_000): Promise<unknown> {
    return waitFor(
      () => this.inventoryHeader(orderId),
      (s) => s === status,
      timeoutMs,
      `stock of ${orderId} ${status}`,
    );
  }

  waitForPaymentHeader(orderId: string, status: string, timeoutMs = 15_000): Promise<unknown> {
    return waitFor(
      () => this.paymentHeader(orderId),
      (s) => s === status,
      timeoutMs,
      `payment of ${orderId} ${status}`,
    );
  }

  get saga(): SagaObserver {
    if (this.sagaObserver === undefined) throw new Error('the stack is not up');
    return this.sagaObserver;
  }

  async scrapeMetrics(name: AppService): Promise<MetricSample[]> {
    const res = expectStatus(await this.direct(name, 'GET', '/metrics', { token: this.secrets.metricsToken }), 200);
    return parseMetrics(res.body as string);
  }

  scrapeOrderMetrics(): Promise<MetricSample[]> {
    return this.scrapeMetrics('order-service');
  }

  mailsTo(email: string) {
    return mailsTo(this.urlOf(this.mailpit, 8025), email);
  }

  queueJobs(queue: string, name: string): Promise<QueuedJob[]> {
    return queueJobs({ host: this.redis.getHost(), port: this.redis.getMappedPort(6379) }, queue, name);
  }

  url(name: ServiceName, port = APP_PORT): string {
    return `http://${this.address(name, port)}`;
  }

  // --- wiring ----------------------------------------------------------------------------------

  private address(name: ServiceName, port: number): string {
    const { container } = this.slot(name);
    return `${container.getHost()}:${container.getMappedPort(port)}`;
  }

  private urlOf(container: StartedTestContainer, port: number): string {
    return `http://${container.getHost()}:${container.getMappedPort(port)}`;
  }

  private slot(name: ServiceName): Slot {
    const slot = this.slots.get(name);
    if (slot === undefined) throw new Error(`${name} is not part of the stack`);
    return slot;
  }

  private async docker(name: ServiceName) {
    return { client: await getContainerRuntimeClient(), container: this.slot(name).container };
  }

  private async launch(name: ServiceName, env: Env, launch: Slot['launch']): Promise<void> {
    this.slots.set(name, { container: await launch(env), launch, env, overridden: false, removed: false });
  }

  private launchApp(app: AppService): Promise<void> {
    return this.launch(app, this.env[app], (env) =>
      new GenericContainer(APP_IMAGES[app].tag)
        .withNetwork(this.network)
        .withNetworkAliases(app)
        .withEnvironment(env)
        .withExposedPorts(APP_PORT)
        .withWaitStrategy(Wait.forHttp('/health/ready', APP_PORT))
        .withStartupTimeout(120_000)
        .start(),
    );
  }

  private async runOnce(app: AppService, command: string[]): Promise<void> {
    await new GenericContainer(APP_IMAGES[app].tag)
      .withNetwork(this.network)
      .withEnvironment(this.env[app])
      .withCommand(command)
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(180_000)
      .start();
  }

  private startPostgres(): Promise<StartedTestContainer> {
    return (
      new GenericContainer('postgres:16-alpine')
        .withNetwork(this.network)
        .withNetworkAliases('postgres')
        .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: this.secrets.pgPassword, POSTGRES_DB: 'api' })
        // Five services' pools plus Temporal's on one server.
        .withCommand(['postgres', '-c', 'max_connections=300'])
        .withCopyContentToContainer([
          {
            content: DATABASES.filter((db) => db !== 'api')
              .map((db) => `CREATE DATABASE ${db};`)
              .join('\n'),
            target: '/docker-entrypoint-initdb.d/databases.sql',
          },
        ])
        .withExposedPorts(5432)
        // The init server logs it once before restarting on TCP.
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start()
    );
  }

  private startRedis(): Promise<StartedTestContainer> {
    return (
      new GenericContainer('redis:7-alpine')
        .withNetwork(this.network)
        .withNetworkAliases('redis')
        // The services refuse a Redis that can lose session epochs or queued jobs.
        .withCommand(['redis-server', '--appendonly', 'yes'])
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start()
    );
  }

  private startMailpit(): Promise<StartedTestContainer> {
    return new GenericContainer('axllent/mailpit:v1.31.1')
      .withNetwork(this.network)
      .withNetworkAliases('mailpit')
      .withExposedPorts(8025)
      .withWaitStrategy(Wait.forHttp('/api/v1/info', 8025))
      .start();
  }

  private temporalEnv(): Env {
    return {
      DB: 'postgres12',
      DB_PORT: '5432',
      POSTGRES_SEEDS: 'postgres',
      POSTGRES_USER: PG_USER,
      POSTGRES_PWD: this.secrets.pgPassword,
      BIND_ON_IP: '0.0.0.0',
      NUM_HISTORY_SHARDS: '4',
      TEMPORAL_NAMESPACE: 'jcool',
      TEMPORAL_NAMESPACE_RETENTION: '1d',
    };
  }

  private temporalContainer(env: Env): GenericContainer {
    return (
      new GenericContainer(TEMPORAL_IMAGE.tag)
        .withNetwork(this.network)
        .withNetworkAliases('temporal')
        .withEnvironment(env)
        .withExposedPorts(TEMPORAL_PORT)
        // The entrypoint creates the search attributes last, as compose's healthcheck relies on. Matching
        // can still be out of its ring then: back on a new IP it first waits out ringpop's 30s join limit
        // against its old address, so a task queue lookup has to answer as well.
        .withWaitStrategy(
          Wait.forSuccessfulCommand(
            'temporal --address 127.0.0.1:7233 operator search-attribute list --namespace jcool | grep -q CheckoutDeadlineAt' +
              ' && temporal --address 127.0.0.1:7233 task-queue describe --namespace jcool --task-queue readiness-probe',
          ),
        )
        .withStartupTimeout(180_000)
    );
  }

  private gatewayEnv(): Env {
    return {
      PORT: String(GATEWAY_PORT),
      API_UPSTREAM: `api:${APP_PORT}`,
      AUTH_UPSTREAM: `user-service:${APP_PORT}`,
      AUTH_UPSTREAM_REQUIRED: 'true',
      INVENTORY_UPSTREAM: `inventory-service:${APP_PORT}`,
      PAYMENT_UPSTREAM: `payment-service:${APP_PORT}`,
      ORDER_UPSTREAM: `order-service:${APP_PORT}`,
      ID_LB_PORT: '4000',
      ID_SERVICE_HOST: 'id-service',
      ID_SERVICE_PORT: String(APP_PORT),
      TRUSTED_PROXY_CIDRS: '',
      CHECKOUT_WRITE_FREEZE: 'false',
      GATEWAY_SHUTDOWN_DELAY: '0s',
      // Zero would be an endless grace period to Caddy.
      GATEWAY_GRACE_PERIOD: '1ms',
    };
  }

  // Railway's healthcheck for the gateway, which is the api's readiness behind it.
  private gatewayContainer(env: Env): GenericContainer {
    return new GenericContainer(GATEWAY_IMAGE)
      .withNetwork(this.network)
      .withNetworkAliases('gateway')
      .withEnvironment(env)
      .withExposedPorts(GATEWAY_PORT, 4000)
      .withWaitStrategy(Wait.forHttp('/health/ready', GATEWAY_PORT))
      .withStartupTimeout(60_000);
  }

  private async catalogVariantIds(): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1, totalPages = 1; page <= totalPages; page++) {
      const res = expectStatus(await this.public('GET', `/products?page=${page}&pageSize=100`), 200);
      totalPages = res.body.totalPages;
      for (const product of res.body.items as { variants: { id: string }[] }[]) {
        ids.push(...product.variants.map((variant) => variant.id));
      }
    }
    return ids;
  }
}

async function request(
  method: string,
  url: string,
  { token, body, headers = {} }: { token?: string; body?: unknown; headers?: Env },
): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (res.headers.get('content-type')?.includes('json')) parsed = JSON.parse(text);
  return { status: res.status, body: parsed, headers: res.headers };
}

export function expectStatus<T extends HttpResult>(res: T, status: number): T {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

/** Polls until `done`, failing with the last value seen. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (done(last)) return last;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
