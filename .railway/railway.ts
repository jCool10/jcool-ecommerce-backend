import { database, defineRailway, github, preserve, project, service } from 'railway/iac';

export const partial = 'api';

const API_SERVICE = 'jcool-ecommerce-backend';
const API_PORT = '8080';
const ID_SERVICE_PORT = '3000';

// A service owns its variables: any name missing here is deleted on apply. preserve() keeps the value
// that lives in Railway, so secrets and runtime flags never enter the repo.
const API_VARIABLES = [
  'APP_PUBLIC_URL',
  'ARGON2_MEMORY_COST',
  'ARGON2_PARALLELISM',
  'ARGON2_TIME_COST',
  'DATABASE_URL',
  'EMAIL_VERIFICATION_TTL',
  'GRAFANA_ADMIN_PASSWORD',
  'IDENTITY_BUCKET_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_TTL',
  'LOG_LEVEL',
  'MAIL_FROM',
  'NODE_ENV',
  'PASSWORD_RESET_TTL',
  'PAYMENT_WEBHOOK_SECRET',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'REDIS_HOST_PORT',
  'REDIS_URL',
  'REFRESH_TOKEN_TTL',
  'SEARCH_API_KEY',
  'SEARCH_ENABLED',
  'SEARCH_HOST_PORT',
  'SEARCH_URL',
  'SMTP_URL',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_BUCKET',
  'STORAGE_ENDPOINT',
  'STORAGE_SECRET_ACCESS_KEY',
  'SWAGGER_ENABLED',
  'THROTTLE_ENABLED',
  // Flipped by hand with the public domain (RUNBOOK), so an apply never reverts it.
  'TRUST_PROXY',
];

const preserved = (names: string[]) => Object.fromEntries(names.map((name) => [name, preserve()]));

export default defineRailway(() => {
  const api = service(API_SERVICE, {
    source: github('jCool10/jcool-ecommerce-backend', { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      numReplicas: 1,
      preDeployCommand: ['npm run db:migrate:prod'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 15,
    },
    // Pinned rather than left to Railway's default: the gateway dials it.
    env: { ...preserved(API_VARIABLES), PORT: API_PORT },
  });

  // postgres() would pick 18; the tests and compose run 16.
  const idPostgres = database('id-postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
    defaultMountPath: '/var/lib/postgresql/data',
  });

  // No source: CD uploads each build with `railway up`, so nothing deploys on its own.
  const idService = service('id-service', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/id-service/Dockerfile' },
    deploy: {
      numReplicas: 3,
      preDeployCommand: ['node dist/database/migrate-cli.js'],
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      // Grace period, HTTP close, then the worst-case node release: about 16s.
      drainingSeconds: 20,
    },
    env: {
      NODE_ENV: 'production',
      PORT: ID_SERVICE_PORT,
      DATABASE_URL: idPostgres.env.DATABASE_URL,
      SHUTDOWN_GRACE_PERIOD_MS: '8000',
    },
  });

  const gateway = service('gateway', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'apps/gateway/Dockerfile' },
    deploy: {
      numReplicas: 1,
      // Proxied to the api: a gateway that cannot reach it never takes traffic.
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
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
      ID_SERVICE_HOST: idService.env.RAILWAY_PRIVATE_DOMAIN,
      ID_SERVICE_PORT,
      ID_LB_IP_VERSIONS: 'ipv6',
      // Set by hand: the edge ranges come from a probe, the auth flip from its RUNBOOK step.
      ...preserved(['TRUSTED_PROXY_CIDRS', 'AUTH_UPSTREAM', 'AUTH_UPSTREAM_REQUIRED']),
    },
  });

  return project('jcool ecommerce backend', { resources: [api, idPostgres, idService, gateway] });
});
