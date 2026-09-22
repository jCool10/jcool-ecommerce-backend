# Built from the repository root: docker build -f apps/user-service/Dockerfile .
FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@jcool/user-service..."
RUN pnpm --filter "@jcool/user-service..." run build
RUN pnpm deploy --filter=@jcool/user-service --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /repo/apps/user-service/dist ./dist
# tsc skips the .sql files; `node dist/database/migrate-cli.js` applies them as a pre-deploy step.
COPY --from=builder /repo/apps/user-service/src/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
