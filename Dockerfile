# Multi-stage image for the NestJS app.
#   builder  — install all deps + compile TypeScript to the build output
#   runtime  — production deps only + compiled output, runs as non-root
# Node 24 (Alpine): current deps require Node >=22 (undici, testcontainers, dependency-cruiser,
# commander) and the package-lock.json is authored by npm 11, which ships with Node 24 — an older
# base (e.g. node:20, npm 10.8) rejects that lock with a spurious "Missing from lock file" on npm ci.

# ---- builder ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# SWC emits .js only, so the migration .sql files never reach dist/ — copy them straight from the
# builder. MIGRATIONS_DIR is absolute because this image has no src/ tree for the CWD-relative
# default to resolve against. Apply them as a release command (npm run db:migrate:prod), not from
# app bootstrap: a bad migration must stop the rollout, not crashloop the running version.
COPY --from=builder /app/src/shared/infrastructure/database/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
USER node
CMD ["node", "dist/main.js", "./dist/instrumentation.js"]
