# Multi-stage image for the NestJS app.
#   builder  — install all deps + compile TypeScript to the build output
#   runtime  — production deps only + compiled output, runs as non-root
# Node 20 is pinned to match .nvmrc and package.json "engines".

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
