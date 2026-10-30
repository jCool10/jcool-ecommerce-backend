# Built from the repository root: docker build -f apps/order-service/Dockerfile .
# Debian slim, not Alpine: the Temporal worker's native core ships glibc builds only.
FROM node:24-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@jcool/order-service..."
# Also writes dist/workflows/checkout-saga.bundle.js; the worker loads that, never the TS sources.
RUN pnpm --filter "@jcool/order-service..." run build
RUN pnpm deploy --filter=@jcool/order-service --prod /out

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /repo/apps/order-service/dist ./dist
# tsc skips the .sql files; `node dist/database/migrate-cli.js` applies them as a pre-deploy step.
COPY --from=builder /repo/apps/order-service/src/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
