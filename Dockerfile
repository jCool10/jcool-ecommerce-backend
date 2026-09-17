# Node 24: current deps require Node >=22 (undici, testcontainers, dependency-cruiser, commander) and
# package-lock.json is authored by npm 11, which ships with Node 24 — an older base (e.g. node:20,
# npm 10.8) rejects that lock with a spurious "Missing from lock file" on npm ci.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/checkout-core/package.json apps/checkout-core/
COPY packages/kernel/package.json packages/kernel/
COPY packages/identity/package.json packages/identity/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/checkout-core/package.json apps/checkout-core/
COPY packages/kernel/package.json packages/kernel/
COPY packages/identity/package.json packages/identity/
RUN npm ci --omit=dev --workspace @jcool/checkout-core --include-workspace-root && npm cache clean --force
COPY --from=builder /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=builder /app/packages/identity/dist ./packages/identity/dist
COPY --from=builder /app/apps/checkout-core/dist ./apps/checkout-core/dist
# SWC emits .js only, so the migration .sql files never reach dist/ — copy them straight from the
# builder. MIGRATIONS_DIR is absolute because this image has no src/ tree to resolve against. Apply
# them as a release command (npm run db:migrate:prod): a bad migration must stop the rollout, not
# crashloop the running version.
COPY --from=builder /app/apps/checkout-core/src/shared/infrastructure/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
# The app manifest must be the working directory: railway.json's preDeployCommand runs its npm
# scripts, and the OpenAPI document reads its version.
WORKDIR /app/apps/checkout-core
EXPOSE 3000
USER node
# `--import`, not a trailing argument: Node would take the second path as argv[2] and never load it,
# leaving Sentry silently uninitialised. Both exporters are runtime-gated (OTEL_ENABLED / SENTRY_DSN),
# so a hosted deployment gets error tracking without the local observability stack coming with it.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
