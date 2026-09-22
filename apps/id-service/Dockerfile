# Built from the repository root: docker build -f apps/id-service/Dockerfile .
FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# Only this service and the workspace packages it depends on: the api's native builds stay out.
RUN pnpm install --offline --frozen-lockfile --filter "@jcool/id-service..."
RUN pnpm --filter "@jcool/id-service..." run build
RUN pnpm deploy --filter=@jcool/id-service --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /repo/apps/id-service/dist ./dist
# tsc leaves the .sql files behind; applied by `node dist/database/migrate-cli.js` as a pre-deploy step.
COPY --from=builder /repo/apps/id-service/src/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
# Exec form with node as PID 1, so SIGTERM reaches Nest and the lease is drained and released.
CMD ["node", "dist/main.js"]
