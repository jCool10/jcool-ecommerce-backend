import { bucket, database, defineRailway, github, preserve, project, ref, service, volume } from 'railway/iac';

export const partial = 'api';

const API_SERVICE = 'jcool-ecommerce-backend';
const API_PORT = '8080';
const ID_SERVICE_PORT = '3000';
const ID_LB_PORT = '4000';
const ID_ETCD_PORT = '2379';
const USER_SERVICE_PORT = '3000';
const INVENTORY_SERVICE_PORT = '3000';
const PAYMENT_SERVICE_PORT = '3000';
const ORDER_SERVICE_PORT = '3000';
const PROMETHEUS_PORT = '9090';
const GRAFANA_PORT = '3000';
const LOKI_PORT = '3100';
const ELASTICSEARCH_PORT = '9200';
const TEMPORAL_PORT = '7233';
const TEMPORAL_NAMESPACE = 'jcool';
const TEMPORAL_TASK_QUEUE = 'checkout-saga';

// Every Node service ships its pino lines here as well as to stdout; unset, they go to stdout only.
const LOKI_URL = `http://\${{loki.RAILWAY_PRIVATE_DOMAIN}}:${LOKI_PORT}`;

// A service owns its variables: any name missing here is deleted on apply. preserve() keeps the value
// that lives in Railway, so secrets and runtime flags never enter the repo.
const API_VARIABLES = [
  // The order-service's caller token, pair and rotation slot, for carts and SKU views.
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
  'LOG_LEVEL',
  // Read by MetricsTokenGuard: unset, /metrics answers 404 in production and Prometheus sees nothing.
  'METRICS_TOKEN',
  'NODE_ENV',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'REDIS_HOST_PORT',
  'SEARCH_ENABLED',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_BUCKET',
  'STORAGE_ENDPOINT',
  'STORAGE_SECRET_ACCESS_KEY',
  'SWAGGER_ENABLED',
  'THROTTLE_ENABLED',
  // Flipped by hand with the public domain (RUNBOOK), so an apply never reverts it.
  'TRUST_PROXY',
];

const USER_SERVICE_VARIABLES = [
  'APP_PUBLIC_URL',
  'ARGON2_MEMORY_COST',
  'ARGON2_PARALLELISM',
  'ARGON2_TIME_COST',
  'CSRF_SECRET',
  'EMAIL_VERIFICATION_TTL',
  'IDENTITY_PIN_BOOTSTRAP',
  'INTERNAL_API_TOKEN',
  'INTERNAL_API_TOKEN_PREVIOUS',
  // The inventory-service's caller token, allowed to read session epochs only.
  'INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE',
  'INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE_PREVIOUS',
  // The order-service's, for session epochs and the order.paid mail's user summary.
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
  'JWT_ACCESS_TTL',
  'JWT_AUDIENCE',
  'JWT_ES256_ACTIVE_KID',
  'JWT_ES256_PRIVATE_KEYS',
  'JWT_ISSUER',
  'LOG_LEVEL',
  'MAIL_FROM',
  'PASSWORD_RESET_TTL',
  'REFRESH_TOKEN_TTL',
  'SMTP_URL',
  'THROTTLE_ENABLED',
];

// A caller token per caller, pair and rotation slot; each caller references the first one.
const INVENTORY_SERVICE_VARIABLES = [
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
];

// The same pairs, plus the webhook secret and the provider's keys.
const PAYMENT_SERVICE_VARIABLES = [
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE',
  'INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS',
  'PAYMENT_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_SUCCESS_URL',
  'STRIPE_CANCEL_URL',
];

// Copied from the api at the cut-over (RUNBOOK); the invariant floor stays empty, as the database
// starts empty.
const ORDER_SERVICE_VARIABLES = ['CHECKOUT_INVARIANT_NOT_BEFORE', 'MAIL_FROM', 'SMTP_URL'];

const preserved = (names: string[]) => Object.fromEntries(names.map((name) => [name, preserve()]));

// The api's Postgres and Redis predate the IaC and stay outside it. Referencing them by name keeps
// the URLs in step with the databases and draws the links on Railway's canvas.
const API_DATABASE_URL = '${{Postgres.DATABASE_URL}}';
const REDIS_URL = '${{Redis.REDIS_URL}}';

export default defineRailway(() => {
  const api = service(API_SERVICE, {
    // No branch: a branch here is Railway's autodeploy trigger, which deploys every push to main
    // before CI has run. Only cd.yml deploys, and only once CI is green.
    source: github('jCool10/jcool-ecommerce-backend'),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      numReplicas: 1,
      preDeployCommand: ['npm run db:migrate:prod'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 120,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 30,
    },
    env: {
      ...preserved(API_VARIABLES),
      // Pinned rather than left to Railway's default: the gateway dials it.
      PORT: API_PORT,
      DATABASE_URL: API_DATABASE_URL,
      REDIS_URL,
      // Railway keeps routing to the old deployment for a moment after SIGTERM, and kills it when
      // drainingSeconds runs out. The shutdown steps take at most this grace + one BullMQ close of
      // 5000 + 1000 Redis quit = 11000 ≤ 30 × 1000 − 1000. The outbox relay drain (5000, before the
      // steps) and the telemetry flush (3000, after them) are not in the sum; RUNBOOK "The shutdown
      // budget".
      SHUTDOWN_GRACE_PERIOD_MS: '5000',
      // Every request depends on these: the api verifies what the user-service signed, and reads
      // an epoch or an address from it. Referenced, not preserved, so the two cannot drift.
      JWT_ISSUER: '${{user-service.JWT_ISSUER}}',
      JWT_AUDIENCE: '${{user-service.JWT_AUDIENCE}}',
      INTERNAL_API_TOKEN: '${{user-service.INTERNAL_API_TOKEN}}',
      USER_SERVICE_INTERNAL_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}`,
      AUTH_JWKS_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}/.well-known/jwks.json`,
      // Every row id is minted there, through the gateway's internal load balancer.
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      LOKI_URL,
      // A user limited to products* (RUNBOOK); its password lives on the elasticsearch service.
      SEARCH_URL: `http://\${{elasticsearch.RAILWAY_PRIVATE_DOMAIN}}:${ELASTICSEARCH_PORT}`,
      SEARCH_USERNAME: 'jcool_api',
      SEARCH_PASSWORD: '${{elasticsearch.API_SEARCH_PASSWORD}}',
    },
  });

  // The node floors live here, so a lost volume means the RUNBOOK's floor lift before any replica mints.
  const idEtcdData = volume('id-etcd-data', { sizeMB: 1_000, region: 'iad' });

  // No domain and no TCP proxy: only the id-service talks to it, over the private network.
  const idEtcd = service('id-etcd', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/etcd/Dockerfile' },
    deploy: { numReplicas: 1, healthcheckPath: '/health', healthcheckTimeout: 60, restartPolicyMaxRetries: 5 },
    volumeMounts: { '/var/lib/etcd': idEtcdData },
    env: {
      // Read by Railway's healthcheck only; etcd listens where infra/etcd/Dockerfile says.
      PORT: ID_ETCD_PORT,
      ETCD_ADVERTISE_CLIENT_URLS: `http://\${{RAILWAY_PRIVATE_DOMAIN}}:${ID_ETCD_PORT}`,
    },
  });

  // No source: CD uploads each build with `railway up`, so nothing deploys on its own.
  const idService = service('id-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/id-service/Dockerfile' },
    deploy: {
      numReplicas: 3,
      // A no-op once the keyspace has floors; on an empty one it lifts them to now (RUNBOOK cut-over).
      preDeployCommand: ['node dist/lease/lift-floors-cli.js --if-uninitialized'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      // Grace period, HTTP close, then the worst-case node release: about 16s.
      drainingSeconds: 20,
    },
    env: {
      NODE_ENV: 'production',
      PORT: ID_SERVICE_PORT,
      ETCD_ENDPOINTS: `http://\${{id-etcd.RAILWAY_PRIVATE_DOMAIN}}:${ID_ETCD_PORT}`,
      SHUTDOWN_GRACE_PERIOD_MS: '8000',
      LOKI_URL,
    },
  });

  const gateway = service('gateway', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/gateway/Dockerfile' },
    deploy: {
      numReplicas: 1,
      // Proxied to the api: a gateway that cannot reach it never takes traffic.
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      // Caddy's shutdown_delay plus grace_period.
      drainingSeconds: 20,
    },
    // IPv6 only: the private DNS answers both families and Go dials IPv4 first, while the api trusts
    // fd12::/16 alone. Legacy, IPv6-only environments agree.
    env: {
      PORT: '8080',
      API_UPSTREAM: `tcp6/\${{${API_SERVICE}.RAILWAY_PRIVATE_DOMAIN}}:${API_PORT}`,
      INVENTORY_UPSTREAM: `tcp6/\${{inventory-service.RAILWAY_PRIVATE_DOMAIN}}:${INVENTORY_SERVICE_PORT}`,
      PAYMENT_UPSTREAM: `tcp6/\${{payment-service.RAILWAY_PRIVATE_DOMAIN}}:${PAYMENT_SERVICE_PORT}`,
      ORDER_UPSTREAM: `tcp6/\${{order-service.RAILWAY_PRIVATE_DOMAIN}}:${ORDER_SERVICE_PORT}`,
      ID_SERVICE_HOST: idService.env.RAILWAY_PRIVATE_DOMAIN,
      ID_SERVICE_PORT,
      ID_LB_PORT,
      ID_LB_IP_VERSIONS: 'ipv6',
      // Set by hand: the edge ranges come from a probe, the auth upstream from its RUNBOOK step,
      // and the write freezes only while auth or checkout writes have to stop.
      // check-railway-flip-vars.mjs keeps them declared here.
      ...preserved([
        'TRUSTED_PROXY_CIDRS',
        'AUTH_UPSTREAM',
        'AUTH_UPSTREAM_REQUIRED',
        'AUTH_WRITE_FREEZE',
        'CHECKOUT_WRITE_FREEZE',
      ]),
    },
  });

  const userPostgres = database('user-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No domain of its own: the gateway's AUTH_UPSTREAM is the only way in.
  const userService = service('user-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/user-service/Dockerfile' },
    deploy: {
      numReplicas: 1,
      preDeployCommand: ['node dist/database/migrate-cli.js'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 15,
    },
    env: {
      ...preserved(USER_SERVICE_VARIABLES),
      NODE_ENV: 'production',
      PORT: USER_SERVICE_PORT,
      DATABASE_URL: userPostgres.env.DATABASE_URL,
      // The api's instance: auth:* is read there.
      REDIS_URL,
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      // Only ever reached over the private network.
      TRUST_PROXY: 'fd12::/16',
      SHUTDOWN_GRACE_PERIOD_MS: '5000',
      LOKI_URL,
    },
  });

  const inventoryPostgres = database('inventory-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No source, like the id-service: CD uploads it. No domain: the gateway's INVENTORY_UPSTREAM and the
  // order-service's internal calls are the only ways in.
  const inventoryService = service('inventory-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/inventory-service/Dockerfile' },
    deploy: {
      numReplicas: 1,
      // The seed only tops up variants with no row yet, and gives up quietly while the catalog is down.
      preDeployCommand: ['node dist/database/pre-deploy-cli.js'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 15,
    },
    env: {
      ...preserved(INVENTORY_SERVICE_VARIABLES),
      NODE_ENV: 'production',
      PORT: INVENTORY_SERVICE_PORT,
      DATABASE_URL: inventoryPostgres.env.DATABASE_URL,
      // The api's instance, for auth:* and the throttler.
      REDIS_URL,
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      // The admin routes verify what the user-service signed, as the api does.
      AUTH_JWKS_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}/.well-known/jwks.json`,
      JWT_ISSUER: '${{user-service.JWT_ISSUER}}',
      JWT_AUDIENCE: '${{user-service.JWT_AUDIENCE}}',
      USER_SERVICE_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}`,
      USER_SERVICE_TOKEN: '${{user-service.INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE}}',
      // The seed reads the public catalog through the gateway, never the api directly.
      CATALOG_PUBLIC_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:8080`,
      // One token for every scrape target, so Prometheus needs only the one.
      METRICS_TOKEN: `\${{${API_SERVICE}.METRICS_TOKEN}}`,
      TRUST_PROXY: 'fd12::/16',
      SHUTDOWN_GRACE_PERIOD_MS: '5000',
      LOKI_URL,
    },
  });

  const paymentPostgres = database('payment-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No source, like the inventory-service. No domain: the gateway's PAYMENT_UPSTREAM (the webhook) and
  // the order-service's internal calls are the only ways in.
  const paymentService = service('payment-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/payment-service/Dockerfile' },
    deploy: {
      numReplicas: 1,
      preDeployCommand: ['node dist/database/migrate-cli.js'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 15,
    },
    env: {
      ...preserved(PAYMENT_SERVICE_VARIABLES),
      NODE_ENV: 'production',
      PORT: PAYMENT_SERVICE_PORT,
      DATABASE_URL: paymentPostgres.env.DATABASE_URL,
      // The api's instance and the default QUEUE_PREFIX: payment.authorized lands on the
      // order-service's order-events.
      REDIS_URL,
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      METRICS_TOKEN: `\${{${API_SERVICE}.METRICS_TOKEN}}`,
      TRUST_PROXY: 'fd12::/16',
      SHUTDOWN_GRACE_PERIOD_MS: '5000',
      // Stamped on every payment.authorized job. The order-service runs on its code default, so
      // nothing here can reference it: change one, change both (RUNBOOK cross rules).
      ORDER_PAID_CONSUMER_ATTEMPTS: '15',
      LOKI_URL,
    },
  });

  const orderPostgres = database('order-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No source, like the payment-service. No domain: the gateway's ORDER_UPSTREAM is the only way in.
  const orderService = service('order-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/order-service/Dockerfile' },
    deploy: {
      numReplicas: 1,
      preDeployCommand: ['node dist/database/migrate-cli.js'],
      // Includes Temporal, unlike the api's: with Temporal down, CD stops here, before the api.
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 120,
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      // The shutdown steps take at most SHUTDOWN_GRACE_PERIOD_MS + Temporal worker grace and force
      // (defaults) + 1000 stop slack + two 5000 waits closing order-events
      // = 5000 + 4000 + 4000 + 1000 + 2 × 5000 = 24000 ≤ 30 × 1000 − 1000.
      drainingSeconds: 30,
    },
    env: {
      ...preserved(ORDER_SERVICE_VARIABLES),
      NODE_ENV: 'production',
      PORT: ORDER_SERVICE_PORT,
      DATABASE_URL: orderPostgres.env.DATABASE_URL,
      // The api's instance: auth:*, the throttler, and the order-events queue.
      REDIS_URL,
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      AUTH_JWKS_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}/.well-known/jwks.json`,
      JWT_ISSUER: '${{user-service.JWT_ISSUER}}',
      JWT_AUDIENCE: '${{user-service.JWT_AUDIENCE}}',
      // Each token is the target's INTERNAL_CALLER_TOKEN_ORDER_SERVICE, referenced so it cannot drift.
      USER_SERVICE_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}`,
      USER_SERVICE_TOKEN: '${{user-service.INTERNAL_CALLER_TOKEN_ORDER_SERVICE}}',
      // The api's private address, never the gateway: the gateway answers /internal with 404.
      API_SERVICE_URL: `http://\${{${API_SERVICE}.RAILWAY_PRIVATE_DOMAIN}}:${API_PORT}`,
      API_SERVICE_TOKEN: `\${{${API_SERVICE}.INTERNAL_CALLER_TOKEN_ORDER_SERVICE}}`,
      INVENTORY_SERVICE_URL: `http://\${{inventory-service.RAILWAY_PRIVATE_DOMAIN}}:${INVENTORY_SERVICE_PORT}`,
      INVENTORY_SERVICE_TOKEN: '${{inventory-service.INTERNAL_CALLER_TOKEN_ORDER_SERVICE}}',
      PAYMENT_SERVICE_URL: `http://\${{payment-service.RAILWAY_PRIVATE_DOMAIN}}:${PAYMENT_SERVICE_PORT}`,
      PAYMENT_SERVICE_TOKEN: '${{payment-service.INTERNAL_CALLER_TOKEN_ORDER_SERVICE}}',
      // The namespace and task queue the api's worker polled, so open sagas keep a worker.
      TEMPORAL_ADDRESS: `\${{temporal.RAILWAY_PRIVATE_DOMAIN}}:${TEMPORAL_PORT}`,
      TEMPORAL_NAMESPACE,
      TEMPORAL_TASK_QUEUE,
      METRICS_TOKEN: `\${{${API_SERVICE}.METRICS_TOKEN}}`,
      TRUST_PROXY: 'fd12::/16',
      SHUTDOWN_GRACE_PERIOD_MS: '5000',
      LOKI_URL,
    },
  });

  // Workflow histories and visibility. Losing it loses every open saga (RUNBOOK: Operate Temporal).
  const temporalPostgres = database('temporal-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No source: deployed by hand with `railway up` (RUNBOOK). No domain, no TCP proxy and no
  // healthcheck path: the frontend speaks gRPC only and has no auth, so it stays private.
  const temporal = service('temporal', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/temporal/Dockerfile' },
    deploy: { numReplicas: 1, restartPolicyMaxRetries: 5 },
    env: {
      DB: 'postgres12',
      DB_PORT: temporalPostgres.env.PGPORT,
      POSTGRES_SEEDS: temporalPostgres.env.PGHOST,
      POSTGRES_USER: temporalPostgres.env.PGUSER,
      POSTGRES_PWD: temporalPostgres.env.PGPASSWORD,
      // The private network is IPv6.
      BIND_ON_IP: '::',
      // Fixed for the life of temporal-postgres: changing it means a new database.
      NUM_HISTORY_SHARDS: '4',
      TEMPORAL_NAMESPACE,
      TEMPORAL_NAMESPACE_RETENTION: '7d',
    },
  });

  // Derived from the api's Postgres and rebuilt from it, so a lost volume costs a reindex, not data.
  const elasticsearchData = volume('elasticsearch-data', { sizeMB: 5_000, region: 'iad' });

  // No domain and no TCP proxy, ever. No healthcheck path either: with security on, Railway's
  // unauthenticated probe would get 401.
  const elasticsearch = service('elasticsearch', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/elasticsearch/Dockerfile' },
    deploy: { numReplicas: 1, restartPolicyMaxRetries: 5 },
    volumeMounts: { '/usr/share/elasticsearch/data': elasticsearchData },
    env: {
      // API_SEARCH_PASSWORD is jcool_api's: the engine ignores it, the api references it.
      ...preserved(['ELASTIC_PASSWORD', 'API_SEARCH_PASSWORD']),
      ES_JAVA_OPTS: '-Xms512m -Xmx512m',
    },
  });

  // The tsdb outlives a deploy; the retention window is set in railway-entrypoint.sh.
  const prometheusData = volume('prometheus-data', { sizeMB: 5_000, region: 'iad' });

  const prometheus = service('prometheus', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/prometheus/Dockerfile' },
    deploy: {
      numReplicas: 1,
      healthcheckPath: '/-/healthy',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
    },
    volumeMounts: { '/prometheus': prometheusData },
    env: {
      PORT: PROMETHEUS_PORT,
      // Referenced, not preserved: a scraper whose token drifts from the api's gets 404s that look
      // like a missing endpoint.
      METRICS_TOKEN: `\${{${API_SERVICE}.METRICS_TOKEN}}`,
      API_TARGET: `\${{${API_SERVICE}.RAILWAY_PRIVATE_DOMAIN}}:${API_PORT}`,
      INVENTORY_TARGET: `\${{inventory-service.RAILWAY_PRIVATE_DOMAIN}}:${INVENTORY_SERVICE_PORT}`,
      PAYMENT_TARGET: `\${{payment-service.RAILWAY_PRIVATE_DOMAIN}}:${PAYMENT_SERVICE_PORT}`,
      ORDER_TARGET: `\${{order-service.RAILWAY_PRIVATE_DOMAIN}}:${ORDER_SERVICE_PORT}`,
      LOKI_TARGET: `\${{loki.RAILWAY_PRIVATE_DOMAIN}}:${LOKI_PORT}`,
    },
  });

  // Chunks and index live in the bucket. The volume holds only the WAL and compactor state, so a
  // restart replays what was not yet flushed instead of losing it.
  const lokiChunks = bucket('loki-chunks', { region: 'iad' });
  const lokiData = volume('loki-data', { sizeMB: 5_000, region: 'iad' });

  // No domain: the apps push and Grafana queries over the private network, and auth is off.
  const loki = service('loki', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/loki/Dockerfile' },
    deploy: {
      numReplicas: 1,
      // 503 until the ingester has been in the ring for 15s.
      healthcheckPath: '/ready',
      healthcheckTimeout: 120,
      restartPolicyMaxRetries: 5,
    },
    volumeMounts: { '/loki': lokiData },
    env: {
      PORT: LOKI_PORT,
      LOKI_S3_ENDPOINT: ref(lokiChunks, 'ENDPOINT'),
      LOKI_S3_REGION: ref(lokiChunks, 'REGION'),
      LOKI_S3_BUCKET: ref(lokiChunks, 'BUCKET'),
      LOKI_S3_ACCESS_KEY_ID: ref(lokiChunks, 'ACCESS_KEY_ID'),
      LOKI_S3_SECRET_ACCESS_KEY: ref(lokiChunks, 'SECRET_ACCESS_KEY'),
    },
  });

  // The only publicly reachable part of the stack, and the only one with a login.
  const grafana = service('grafana', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'infra/grafana/Dockerfile' },
    deploy: {
      numReplicas: 1,
      healthcheckPath: '/api/health',
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 5,
    },
    env: {
      ...preserved(['GF_SECURITY_ADMIN_PASSWORD']),
      PORT: GRAFANA_PORT,
      GF_SERVER_HTTP_PORT: GRAFANA_PORT,
      GF_SERVER_ROOT_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      GF_USERS_ALLOW_SIGN_UP: 'false',
      // Read by the provisioned datasources.
      PROMETHEUS_URL: `http://\${{prometheus.RAILWAY_PRIVATE_DOMAIN}}:${PROMETHEUS_PORT}`,
      LOKI_URL,
    },
  });

  return project('jcool ecommerce backend', {
    resources: [
      api,
      idEtcdData,
      idEtcd,
      idService,
      gateway,
      userPostgres,
      userService,
      inventoryPostgres,
      inventoryService,
      paymentPostgres,
      paymentService,
      orderPostgres,
      orderService,
      temporalPostgres,
      temporal,
      elasticsearchData,
      elasticsearch,
      prometheusData,
      prometheus,
      lokiChunks,
      lokiData,
      loki,
      grafana,
    ],
  });
});
