# Node 24: current deps require Node >=22 (undici, testcontainers, dependency-cruiser, commander).
FROM node:24-alpine AS builder
WORKDIR /repo
# pnpm version comes from the root `packageManager` field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@jcool/api
RUN pnpm deploy --filter=@jcool/api --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Only the manifest and prod node_modules from the deploy dir: it also carries the app's sources.
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /repo/apps/api/dist ./dist
# SWC emits .js only, so the migration .sql files never reach dist/ — copy them straight from the
# builder. MIGRATIONS_DIR is absolute because this image has no src/ tree to resolve against. Apply
# them as a release command (npm run db:migrate:prod): a bad migration must stop the rollout, not
# crashloop the running version.
COPY --from=builder /repo/apps/api/src/shared/infrastructure/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
# `--import`, not a trailing argument: Node would take the second path as argv[2] and never load it,
# leaving Sentry silently uninitialised. Both exporters are runtime-gated (OTEL_ENABLED / SENTRY_DSN),
# so a hosted deployment gets error tracking without the local observability stack coming with it.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
