import { defineRailway, github, preserve, project, service } from 'railway/iac';

export const partial = 'api';

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
];

export default defineRailway(() => {
  const api = service('jcool-ecommerce-backend', {
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
    env: Object.fromEntries(API_VARIABLES.map((name) => [name, preserve()])),
  });

  return project('jcool ecommerce backend', { resources: [api] });
});
