# Node 24: current deps require Node >=22 (undici, testcontainers, dependency-cruiser, commander) and
# package-lock.json is authored by npm 11, which ships with Node 24 — an older base (e.g. node:20,
# npm 10.8) rejects that lock with a spurious "Missing from lock file" on npm ci.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# SWC emits .js only, so the migration .sql files never reach dist/ — copy them straight from the
# builder. Both journals ship in one image because both apps do; the paths are absolute because this
# image has no source tree to resolve against. Apply them as release commands (db:migrate:prod and
# db:migrate:prod:user): a bad migration must stop the rollout, not crashloop the running version.
COPY --from=builder /app/apps/commerce-core/migrations ./migrations/commerce-core
COPY --from=builder /app/apps/user/migrations ./migrations/user
ENV MIGRATIONS_DIR=/app/migrations/commerce-core
ENV USER_MIGRATIONS_DIR=/app/migrations/user
EXPOSE 3000 3001
USER node
# One image, two entry points: the default is commerce-core and user-service overrides the command
# (see docker-compose.yml). `--import`, not a trailing argument: Node would take the second path as
# argv[2] and never load it, leaving Sentry silently uninitialised. Both exporters are runtime-gated
# (OTEL_ENABLED / SENTRY_DSN), so a hosted deployment gets error tracking without the local
# observability stack coming with it.
CMD ["node", "--import", "./dist/apps/commerce-core/src/instrumentation.js", "dist/apps/commerce-core/src/main.js"]
