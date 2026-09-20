import { database, defineRailway, github, preserve, project, service } from 'railway/iac';

export const partial = 'api';

const API_SERVICE = 'jcool-ecommerce-backend';
const API_PORT = '8080';
const ID_SERVICE_PORT = '3000';
const ID_LB_PORT = '4000';
const USER_SERVICE_PORT = '3000';

// A service owns its variables: any name missing here is deleted on apply. preserve() keeps the value
// that lives in Railway, so secrets and runtime flags never enter the repo.
const API_VARIABLES = [
  'DATABASE_URL',
  'GRAFANA_ADMIN_PASSWORD',
  'LOG_LEVEL',
  'MAIL_FROM',
  'NODE_ENV',
  'PAYMENT_WEBHOOK_SECRET',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'REDIS_HOST_PORT',
  'REDIS_URL',
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

const USER_SERVICE_VARIABLES = [
  'APP_PUBLIC_URL',
  'ARGON2_MEMORY_COST',
  'ARGON2_PARALLELISM',
  'ARGON2_TIME_COST',
  'CSRF_SECRET',
  'EMAIL_VERIFICATION_TTL',
  'IDENTITY_BUCKET_KEY',
  'IDENTITY_PIN_BOOTSTRAP',
  'INTERNAL_API_TOKEN',
  'INTERNAL_API_TOKEN_PREVIOUS',
  'JWT_ACCESS_TTL',
  'JWT_AUDIENCE',
  'JWT_ES256_ACTIVE_KID',
  'JWT_ES256_PRIVATE_KEYS',
  'JWT_ISSUER',
  'LOG_LEVEL',
  'MAIL_FROM',
  'PASSWORD_RESET_TTL',
  // The api's instance: auth:* is read there.
  'REDIS_URL',
  'REFRESH_TOKEN_TTL',
  'SMTP_URL',
  'THROTTLE_ENABLED',
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
    env: {
      ...preserved(API_VARIABLES),
      // Pinned rather than left to Railway's default: the gateway dials it.
      PORT: API_PORT,
      // Every request depends on these: the api verifies what the user-service signed, and reads
      // an epoch or an address from it. Referenced, not preserved, so the two cannot drift.
      JWT_ISSUER: '${{user-service.JWT_ISSUER}}',
      JWT_AUDIENCE: '${{user-service.JWT_AUDIENCE}}',
      INTERNAL_API_TOKEN: '${{user-service.INTERNAL_API_TOKEN}}',
      USER_SERVICE_INTERNAL_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}`,
      AUTH_JWKS_URL: `http://\${{user-service.RAILWAY_PRIVATE_DOMAIN}}:${USER_SERVICE_PORT}/.well-known/jwks.json`,
    },
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
      ID_LB_PORT,
      ID_LB_IP_VERSIONS: 'ipv6',
      // Set by hand: the edge ranges come from a probe, the auth flip and the cutover freeze from
      // their RUNBOOK steps. scripts/check-railway-flip-vars.mjs keeps them declared here.
      ...preserved(['TRUSTED_PROXY_CIDRS', 'AUTH_UPSTREAM', 'AUTH_UPSTREAM_REQUIRED', 'AUTH_WRITE_FREEZE']),
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
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      overlapSeconds: 20,
      drainingSeconds: 15,
    },
    env: {
      ...preserved(USER_SERVICE_VARIABLES),
      NODE_ENV: 'production',
      PORT: USER_SERVICE_PORT,
      DATABASE_URL: userPostgres.env.DATABASE_URL,
      ID_SERVICE_URL: `http://\${{gateway.RAILWAY_PRIVATE_DOMAIN}}:${ID_LB_PORT}`,
      // Only ever reached over the private network.
      TRUST_PROXY: 'fd12::/16',
    },
  });

  return project('jcool ecommerce backend', {
    resources: [api, idPostgres, idService, gateway, userPostgres, userService],
  });
});
