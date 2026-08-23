# JCool E-commerce Backend

> A single-store e-commerce backend built as a **NestJS modular monolith** with a
> **Domain-Driven Design (DDD)** tactical foundation and **Clean Architecture**
> layering — engineered to explore, and defend, the hard problems of transactional
> commerce (concurrency, idempotency, distributed transactions, caching).

<p>
  <a href="https://github.com/jCool10/jcool-ecommerce-backend/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jCool10/jcool-ecommerce-backend/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="Drizzle ORM" src="https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white">
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-4-6E9F18?logo=vitest&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white">
</p>

---

## Table of Contents

- [JCool E-commerce Backend](#jcool-e-commerce-backend)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Architecture](#architecture)
    - [Bounded contexts](#bounded-contexts)
    - [Per-context layering (Clean Architecture)](#per-context-layering-clean-architecture)
    - [Shared packages (controlled exceptions)](#shared-packages-controlled-exceptions)
  - [Tech Stack](#tech-stack)
  - [Project Structure](#project-structure)
  - [Getting Started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [1. Install dependencies](#1-install-dependencies)
    - [2. Configure environment](#2-configure-environment)
    - [3. Start infrastructure (Postgres + Redis)](#3-start-infrastructure-postgres--redis)
    - [4. Run migrations (and optional seed)](#4-run-migrations-and-optional-seed)
    - [5. Run the app](#5-run-the-app)
  - [Environment Variables](#environment-variables)
  - [API Reference](#api-reference)
    - [Auth — `/auth`](#auth--auth)
    - [Catalog (public) — `/products`](#catalog-public--products)
    - [Catalog admin — `/admin` (RBAC `ADMIN`)](#catalog-admin--admin-rbac-admin)
    - [Cart — `/cart`](#cart--cart)
    - [Order — `/orders`](#order--orders)
    - [Health — `/health`](#health--health)
  - [Database \& Migrations](#database--migrations)
  - [Testing](#testing)
  - [Available Scripts](#available-scripts)
  - [Docker](#docker)
  - [Observability](#observability)
  - [Roadmap](#roadmap)
  - [Documentation](#documentation)
  - [License](#license)

---

## Overview

JCool E-commerce backend is a backend for a **single-store** (not multi-vendor) online shop. It is
organized as a **modular monolith**: one deployable process, split into
independent **bounded contexts** with clean boundaries so any context can later be
extracted into its own service without a rewrite.

The core business invariants the system is built to guarantee:

- **Never oversell** — no order flow may drive inventory below zero, even under
  concurrent contention.
- **Never double-charge** — one purchase intent means exactly one payment, even
  when the client retries.
- **Money and stock stay consistent with order state** — a failed payment releases
  any reserved stock.
- **The order is the source of truth** for a transaction — not the cart.

Boundaries are **enforced by tooling**, not convention: `npm run arch:check`
(dependency-cruiser) fails the build if a `domain` layer imports a framework/DB,
if `application` imports `infrastructure`/`interface`, or if one context reaches
into another context's internals.

## Features

Currently implemented:

- **Authentication & Authorization**
  - Register / login with **Argon2id** password hashing (OWASP-minimum cost params, tunable).
  - Short-lived **JWT** access tokens (HS256) with a **Redis `jti` denylist** for immediate logout, + **refresh-token rotation** with server-side hashing.
  - **Cookie-based refresh delivery**: refresh token in an `httpOnly; Secure; SameSite=Strict` cookie (XSS can't read it), with a **signed double-submit CSRF** token guarding the cookie-authenticated routes.
  - **RBAC** via a cross-cutting `@Roles` guard (roles carried in the JWT).
  - **Rate limiting / brute-force protection** (Redis-backed, cross-instance): a global per-IP floor plus tighter, progressive limits on `login` / `register` / `refresh` — the account tier is keyed per (IP, account) so a brute-force run can't lock out other users behind the same NAT.
  - **Auth audit trail**: structured security events (login ok/fail, logout, refresh, refresh-token **reuse**, email verification) emitted as JSON on a dedicated `AuthAudit` log context for SIEM ingestion.
  - **Email verification**: register creates an **unverified** account and sends a single-use, hashed, expiring token; `verify-email` redeems it and `resend-verification` re-issues one (enumeration-safe). An optional gate (`AUTH_REQUIRE_VERIFIED_EMAIL`) refuses login until the address is verified. Mail goes through a `MailerPort` (dev **log** transport; SMTP adapter pluggable).
  - **Password reset**: `forgot-password` emails a single-use, hashed, short-lived reset token (enumeration-safe — always `202`); `reset-password` redeems it, sets the new password, and **revokes every session** (all refresh tokens) so a suspected compromise is fully evicted.
  - **Change password + session management**: `change-password` re-verifies the current credential then signs out everywhere; `sessions` lists a user's active sessions and revokes any one; `logout-all` kills every session at once. Global revocation uses a **per-user session epoch** (a monotonic counter stamped into each access token) so a bump invalidates every outstanding access token immediately — the thing a per-`jti` denylist can't do without tracking every token.
- **Catalog**
  - Public read paths: list products (paginated) and product detail by id or slug.
  - Admin write paths (RBAC `ADMIN`): full CRUD for categories, products, and SKUs, plus price management, with soft-delete support.
  - **Redis cache-aside** on both read paths, wired as a decorator behind the repository port — controllers, use cases and domain are unaware. Every admin write bumps a generation counter embedded in the cache keys, so the whole cached generation is invalidated in `O(1)` and the next read refills; `CATALOG_CACHE_TTL_SEC` bounds staleness if an invalidation is ever missed. Postgres stays the source of truth: a Redis outage degrades a cached read to a fall-through rather than an error, and shows up as `catalog_cache_operations_total{result="error"}`. Note the request as a whole is not Redis-free — the global rate-limit guard runs first and is Redis-backed with no fall-through of its own.
- **Cart**
  - Per-user shopping cart (one active cart per user): add (upsert-accumulate on a repeat SKU), update quantity, remove a line, view, and clear — every mutation returns the full cart.
  - Prices and names are read **live** from Catalog through a published cross-context port (anti-corruption boundary) — the cart never snapshots a price, so the subtotal always reflects the current price; freezing happens only at Order.
  - Scratch space by design: no stock reservation at add-to-cart (that is Order/Inventory in Week 4), and an item whose product was archived after it was added stays in the cart, flagged `isActive: false`.
- **Order**
  - Create an order from the current cart: each line's name and price are **snapshotted** into the order — a later Catalog price change never alters a placed order's total (the order is the transaction source of truth).
  - A pure, table-driven **state machine** (`DRAFT → PENDING`, `DRAFT → CANCELLED` wired; later states declared but not yet enabled) — an illegal transition is rejected with `409`.
  - `place` runs the status change in a DB transaction with reserved seams (a no-op inventory reservation, a declared `OrderPlaced` event, reserved `version` / `idempotency_key` columns) so overselling (BF#1), idempotency (BF#2), and outbox/saga (BF#4) attach in later weeks without a rewrite.
- **Platform**
  - **Security headers** via `helmet` (HSTS, `X-Content-Type-Options: nosniff`, frameguard, no `X-Powered-By`) and a **configurable CORS** allow-list (off by default — same-origin only; opt in via `CORS_ORIGINS`).
  - **OpenAPI / Swagger** docs, config-gated (on in dev, off in prod unless enabled).
  - **Liveness / readiness** health checks (Terminus) probing Postgres and Redis.
  - **Fail-fast config**: the environment schema is validated at boot; a missing or invalid var crashes the process immediately.
  - Global validation pipe (whitelist + reject unknown fields) and a unified HTTP exception filter.
  - Graceful shutdown hooks (drains the Postgres pool on `SIGTERM`/`SIGINT`).

Bounded contexts scaffolded and on the roadmap: **Inventory**, **Payment**
(see [Roadmap](#roadmap)).

## Architecture

**Modular monolith, DDD strategic + tactical design.** Contexts communicate through
application-service interfaces / published-language facades — never by reaching
into each other's repositories.

### Bounded contexts

| Context       | Responsibility                               | Core invariant                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------ |
| **Catalog**   | Products, variants (SKU), prices, categories | Read-heavy → cache-first                         |
| **Inventory** | Stock, reservations, releases                | No negative stock (oversell protection)          |
| **Cart**      | Per-session shopping cart                    | Transient state, not the transaction source      |
| **Order**     | Order lifecycle, checkout orchestration      | Order is the transaction source of truth         |
| **Payment**   | Payment initiation, webhooks, reconciliation | No double-charge (idempotency)                   |
| **User/Auth** | Registration, login, sessions, RBAC          | Refresh-token rotation; role-based authorization |

### Per-context layering (Clean Architecture)

```
interface (controllers, DTOs)
   → application (use cases, orchestration, ports)
      → domain (entities, value objects, domain rules)
         → infrastructure (Drizzle repositories, Redis, adapters)
```

- **domain** — no framework/DB dependency; pure business rules. May import `shared/kernel` and `shared/rbac` only.
- **application** — orchestrates use cases, opens transactions, depends on domain + ports (interfaces).
- **infrastructure** — implements the ports the domain/application define.

### Shared packages (controlled exceptions)

- `src/shared/kernel/` — framework-free DDD building blocks (`ValueObject`, `Entity`, `AggregateRoot`, `DomainError`, `Money`, `Result`, …).
- `src/shared/rbac/` — interface-level RBAC vocabulary (`@Roles`, `RolesGuard`, `Role`), usable by any context without importing the User context.

## Tech Stack

| Concern              | Choice                                               |
| -------------------- | ---------------------------------------------------- |
| Language / Framework | **TypeScript** + **NestJS 11** (Node ≥ 20)           |
| Database             | **PostgreSQL 16** (ACID, native locking)             |
| ORM / Migrations     | **Drizzle ORM** + drizzle-kit (SQL-first)            |
| Cache / Lock / Queue | **Redis 7** (ioredis)                                |
| Auth                 | `@nestjs/jwt` + Passport, Argon2id, refresh rotation |
| API contract         | **REST** + **OpenAPI** (`@nestjs/swagger`)           |
| Validation           | class-validator + class-transformer                  |
| Testing              | **Vitest** + SWC, Supertest (e2e)                    |
| Arch enforcement     | **dependency-cruiser**                               |
| Tooling              | ESLint + Prettier, Docker + Docker Compose           |

Exact dependency versions are the source of truth in [`package.json`](./package.json).

## Project Structure

```
src/
├── main.ts                     # Bootstrap: validation pipe, exception filter, Swagger, shutdown hooks
├── app.module.ts
├── modules/                    # Bounded contexts
│   ├── catalog/
│   │   ├── interface/          # Controllers + DTOs
│   │   ├── application/         # Use cases, services, ports, public facade
│   │   ├── domain/              # Entities, value objects
│   │   └── infrastructure/      # Drizzle repositories, schema, mappers
│   ├── user/                    # Auth context (register/login/refresh/RBAC)
│   ├── cart/                     # Per-user scratch cart (live Catalog pricing)
│   ├── order/                    # Order + state machine (DRAFT→PENDING, price snapshot)
│   ├── inventory/  payment/      # Scaffolded (roadmap)
└── shared/
    ├── kernel/                  # Framework-free DDD building blocks
    ├── rbac/                    # Roles decorator + guard
    ├── config/                  # Env schema validation + typed config
    ├── health/                  # Liveness/readiness indicators
    ├── infrastructure/
    │   ├── database/            # Drizzle module, schema barrel, migrations, seed
    │   └── redis/               # Redis module + service
    └── interface/filters/       # Global HTTP exception filter
docs/                            # Architecture notes + ADRs (decision ledger)
test/                            # e2e config + test mocks
```

## Getting Started

### Prerequisites

- **Node.js ≥ 20** and npm
- **Docker** + **Docker Compose** (for Postgres and Redis)

### 1. Install dependencies

```bash
npm ci
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`. At minimum, set a strong `JWT_ACCESS_SECRET` (≥ 32 chars):

```bash
# generate a secure secret
openssl rand -base64 48
```

### 3. Start infrastructure (Postgres + Redis)

```bash
docker compose up -d postgres redis
```

Ports are deterministic (`5433` for Postgres, `6380` for Redis) to avoid clashing
with any host-installed instances.

### 4. Run migrations (and optional seed)

```bash
npm run db:migrate
npm run db:seed        # optional sample data
```

### 5. Run the app

```bash
npm run start:dev      # watch mode
```

The API is served at **http://localhost:3000** and interactive docs at
**http://localhost:3000/docs**.

## Environment Variables

Validated at startup — an invalid or missing **required** var crashes the process
(fail-fast). Template lives in [`.env.example`](./.env.example).

| Variable             | Required | Default          | Description                                 |
| -------------------- | :------: | ---------------- | ------------------------------------------- |
| `NODE_ENV`           |   Yes    | —                | `development` \| `test` \| `production`     |
| `PORT`               |    No    | `3000`           | HTTP port                                   |
| `SWAGGER_ENABLED`    |    No    | on (off in prod) | Serve OpenAPI docs at `/docs`               |
| `LOG_LEVEL`          |    No    | `debug` dev / `info` prod | pino log level: `trace`\|`debug`\|`info`\|`warn`\|`error` |
| `METRICS_TOKEN`      |    No    | — (open dev / hidden prod) | Bearer token for `GET /metrics` (min 16 chars); wrong/missing → 404 |
| `OTEL_ENABLED`       |    No    | `false`          | Turn on OpenTelemetry tracing ([`adr/0015`](./docs/adr/0015-tracing-opentelemetry-collector-jaeger.md)) |
| `OTEL_SERVICE_NAME`  |    No    | `jcool-api`      | `service.name` stamped on every span        |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4318` | OTLP/HTTP base endpoint of the Collector    |
| `SENTRY_DSN`         |    No    | — (off)          | Sentry project DSN; unset → SDK never initializes ([`adr/0016`](./docs/adr/0016-error-tracking-sentry.md)) |
| `SENTRY_TRACES_SAMPLE_RATE` | No | `0` (errors only) | Fraction (0–1) of transactions sampled for Sentry performance tracing |
| `DATABASE_URL`       |   Yes    | —                | PostgreSQL connection string                |
| `DB_POOL_MAX`        |    No    | `10`             | Max app-side pg pool connections (caps Postgres backends under a spike) |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | No | `5000`     | Fail a pool acquire after this long (pg default `0` = wait forever)      |
| `DB_POOL_IDLE_TIMEOUT_MS` | No  | `10000`          | Reap an idle pooled connection after this long |
| `REDIS_URL`          |   Yes    | —                | Redis connection string                     |
| `JWT_ACCESS_SECRET`  |   Yes    | —                | HS256 secret, **min 32 chars** (no default) |
| `JWT_ACCESS_TTL`     |    No    | `5m`             | Access-token lifetime                       |
| `REFRESH_TOKEN_TTL`  |    No    | `7d`             | Refresh-token lifetime                      |
| `ARGON2_MEMORY_COST` |    No    | `19456`          | Argon2id memory cost (KiB)                  |
| `ARGON2_TIME_COST`   |    No    | `2`              | Argon2id time cost                          |
| `ARGON2_PARALLELISM` |    No    | `1`              | Argon2id parallelism                        |
| `SHUTDOWN_GRACE_PERIOD_MS` | No | `0`         | ms `/health/ready` keeps returning 503 after SIGTERM before the HTTP server closes |
| `THROTTLE_ENABLED`   |    No    | `true`           | Rate limiting on/off (`false` to disable)   |
| `COOKIE_SECURE`      |    No    | on in prod       | `Secure` flag on auth cookies (override for TLS-proxy staging) |
| `CORS_ORIGINS`       |    No    | — (off)          | Comma-separated CORS allow-list; empty = same-origin only |
| `TRUST_PROXY`        |    No    | — (off)          | Express `trust proxy` for `req.ip` (rate-limit + audit); set behind a proxy (hop count / subnet). **Required when deployed behind a reverse proxy** |
| `APP_PUBLIC_URL`     |    No    | `http://localhost:3000` | Base URL for links in outbound email        |
| `EMAIL_VERIFICATION_TTL` | No   | `24h`            | Email-verification token lifetime           |
| `AUTH_REQUIRE_VERIFIED_EMAIL` | No | `false`        | Refuse login until the email is verified (403) |
| `PASSWORD_RESET_TTL` | No       | `1h`             | Password-reset token lifetime               |
| `CATALOG_CACHE_TTL_SEC` | No    | `60`             | TTL (s) on cached product reads; also the upper bound on staleness from a missed invalidation |

Docker Compose additionally reads `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `POSTGRES_HOST_PORT`, and `REDIS_HOST_PORT` from `.env`; the
`observability` profile (see [Observability](#observability)) also reads
`GRAFANA_ADMIN_PASSWORD`.

## API Reference

No global prefix — routes are served at the root. Full, always-current contract:
**`/docs`** (Swagger UI) when `SWAGGER_ENABLED` is on.

### Auth — `/auth`

| Method | Path             | Auth       | Description                                 |
| ------ | ---------------- | ---------- | ------------------------------------------- |
| `POST` | `/auth/register` | Public     | Create an (unverified) account; sends a verification email |
| `POST` | `/auth/verify-email` | Public | Redeem a single-use verification token (`204`) |
| `POST` | `/auth/resend-verification` | Public | Re-issue a verification email (`202`, enumeration-safe) |
| `POST` | `/auth/forgot-password` | Public | Email a single-use reset token (`202`, enumeration-safe) |
| `POST` | `/auth/reset-password` | Public | Redeem a reset token, set new password, revoke all sessions (`204`) |
| `POST` | `/auth/login`    | Public     | Access token in body; refresh + CSRF set as cookies |
| `GET`  | `/auth/me`       | Bearer     | Current user profile                        |
| `POST` | `/auth/change-password` | Bearer | Re-verify current password, set a new one, revoke every session (`204`) |
| `GET`  | `/auth/sessions` | Bearer     | List the user's active sessions (the current one flagged) |
| `DELETE` | `/auth/sessions/:id` | Bearer | Revoke one session by id (`204`; `404` if not the caller's) |
| `POST` | `/auth/logout-all` | Bearer   | Revoke every session, this device included (session-epoch bump, `204`) |
| `POST` | `/auth/refresh`  | Cookie + CSRF | Rotate tokens (reads the refresh cookie; needs the `x-csrf-token` header) |
| `POST` | `/auth/logout`   | Bearer + CSRF | Revoke the session (denylist access token + refresh token) and clear cookies |

The **refresh token** is delivered only in an `httpOnly; Secure; SameSite=Strict`
cookie (`Path=/auth`) — never in a response body, so JS can't read it. The two
cookie-authenticated routes (`refresh`, `logout`) require a **double-submit CSRF
token**: read the readable `csrf_token` cookie set on login/refresh and echo it in
the `x-csrf-token` header.

### Catalog (public) — `/products`

| Method | Path                  | Auth   | Description                  |
| ------ | --------------------- | ------ | ---------------------------- |
| `GET`  | `/products`           | Public | List products (paginated)    |
| `GET`  | `/products/:idOrSlug` | Public | Product detail by id or slug |

### Catalog admin — `/admin` (RBAC `ADMIN`)

| Method   | Path                              | Description          |
| -------- | --------------------------------- | -------------------- |
| `POST`   | `/admin/categories`               | Create category      |
| `PATCH`  | `/admin/categories/:id`           | Update category      |
| `DELETE` | `/admin/categories/:id`           | Delete category      |
| `POST`   | `/admin/products`                 | Create product       |
| `PATCH`  | `/admin/products/:id`             | Update product       |
| `DELETE` | `/admin/products/:id`             | Delete product       |
| `POST`   | `/admin/products/:productId/skus` | Add SKU to a product |
| `PATCH`  | `/admin/skus/:id`                 | Update SKU           |
| `DELETE` | `/admin/skus/:id`                 | Delete SKU           |
| `PUT`    | `/admin/skus/:skuId/price`        | Set SKU price        |

### Cart — `/cart` (Bearer)

Per-user scratch cart — every endpoint requires a valid access token, and `skuId`
is a **product-variant id** (SKU). Prices/names are read **live** from Catalog
(never snapshotted), quantity is an integer `1..10000`, and every mutation returns
the full cart so the client always sees current state.

| Method   | Path                  | Description                                                              |
| -------- | --------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/cart`               | View the current user's cart (items + subtotal from live prices)        |
| `POST`   | `/cart/items`         | Add `{ skuId, quantity }`; a repeat SKU accumulates (upsert). `404` if the SKU is unknown |
| `PATCH`  | `/cart/items/:skuId`  | Set a line's absolute quantity (`404` if the SKU is not in the cart)     |
| `DELETE` | `/cart/items/:skuId`  | Remove one line (idempotent — `200` even if absent)                      |
| `DELETE` | `/cart`               | Clear the cart                                                          |

The cart is **scratch space, not the transaction source**: the subtotal always
reflects the current Catalog price (a price change is visible on the next read),
and stock/availability are validated only when an Order is placed — an item whose
product was archived after it was added stays in the cart, flagged `isActive: false`.

### Order — `/orders` (Bearer)

The order is the **transaction source of truth** — unlike the cart, an order
**snapshots** each line's price and product name at creation, so a later Catalog
reprice never moves an existing order's total. Every endpoint requires a valid
access token, and orders are **per-user** (another user's order reads as `404`).

| Method | Path                | Description                                                                                          |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------- |
| `POST` | `/orders`           | Create a `DRAFT` order from the current cart (snapshots price + name). `400` if the cart is empty or a line's SKU is unavailable |
| `POST` | `/orders/:id/place` | Place the order (`DRAFT → PENDING`). `409` on an illegal transition, `404` if not found              |
| `GET`  | `/orders`           | List the current user's orders                                                                       |
| `GET`  | `/orders/:id`       | View one order (`404` if unknown or owned by another user)                                           |

The state machine is a pure, table-driven function — Week 3 wires only
`DRAFT → PENDING` (and `DRAFT → CANCELLED`); all later states (`PAID`, `FAILED`,
`EXPIRED`) are declared but not yet reachable. Placement runs in a **DB
transaction** and the order carries reserved seams (`version`, `idempotencyKey`,
an inventory-reservation port, an `OrderPlaced` event) for later boss-fight work,
none of which is implemented yet.

### Health — `/health`

| Method | Path            | Description                                         |
| ------ | --------------- | --------------------------------------------------- |
| `GET`  | `/health/live`  | Liveness (no dependencies checked)                  |
| `GET`  | `/health/ready` | Readiness (503 if Postgres or Redis is unreachable; never rate limited, so a Redis outage is reported rather than masked by the guard) |

## Database & Migrations

The database is managed with **Drizzle ORM**. Schema is defined per-module and
composed through a barrel; migrations are generated as plain SQL and committed to
the repository.

```bash
npm run db:generate    # generate a migration from schema changes
npm run db:migrate     # apply pending migrations
npm run db:studio      # open Drizzle Studio (visual DB browser)
npm run db:seed        # seed sample data
```

## Testing

Two tiers, kept separate on purpose:

- **Unit** (`*.spec.ts`, next to the code) — fast, hermetic, no I/O. Run by `npm test`; needs no Docker.
- **Integration** (`test/**/*.e2e-spec.ts`) — the app wired to **real Postgres + Redis** via
  [Testcontainers](https://testcontainers.com/) (no DB mocking). A single `globalSetup`
  boots both containers once per run, applies the committed Drizzle migrations, and hands the
  connection URLs to tests; `resetDatabase()` truncates between tests for isolation.
  Run by `npm run test:e2e`; **requires Docker running**.

```bash
npm test               # run all unit tests once (Vitest) — no Docker needed
npm run test:watch     # unit watch mode
npm run test:cov       # unit coverage report
npm run test:e2e       # integration tests (Testcontainers Postgres + Redis) — needs Docker
```

Reusable integration helpers live in `test/setup/` (`global-setup`, `test-app.factory`,
`reset-database`, and `fixtures/`). Vitest runs through **SWC**, which emits the decorator
metadata NestJS DI requires. Because SWC is transpile-only, `tsc --noEmit` (via `nest build`)
is the separate type-check gate.

## Available Scripts

| Script               | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run start:dev`  | Run in watch mode                                    |
| `npm run start:prod` | Run the compiled build (`dist/main`)                 |
| `npm run build`      | Compile TypeScript (also the type-check gate)        |
| `npm run lint`       | ESLint (auto-fix)                                    |
| `npm run format`     | Prettier                                             |
| `npm run arch:check` | Enforce architecture boundaries (dependency-cruiser) |
| `npm test`           | Run tests                                            |
| `npm run db:migrate` | Apply database migrations                            |

## Docker

A multi-stage [`Dockerfile`](./Dockerfile) builds a lean production image (Node 20
Alpine, non-root user, prod-only dependencies).

```bash
# Infrastructure only (recommended for local dev)
docker compose up -d postgres redis

# Full stack (app + infra) in-network
docker compose up -d --build

# Tear everything down, including volumes
docker compose down -v
```

Inside the Compose network the app reaches services by name (`postgres:5432`,
`redis:6379`); from the host, use the mapped ports (`5433`, `6380`).

## Observability

Three pillars + error tracking, wired **around** the Clean Architecture core —
`domain`/`application` import none of this (dependency-cruiser enforced, see
[`adr/0009`](./docs/adr/0009-architecture-boundary-enforcement.md)):

- **Logs** — structured JSON via `nestjs-pino`. Every log line of a request
  carries the same `requestId` (correlation id, via `nestjs-cls` +
  `AsyncLocalStorage`), also echoed back as the `x-request-id` response
  header. See [`adr/0013`](./docs/adr/0013-structured-logging-pino-correlation.md).
- **Metrics** — `GET /metrics` (Prometheus text format): default process
  metrics, RED HTTP metrics (`route` as a path template, never a raw id),
  and business counters. Guarded by `METRICS_TOKEN` — a missing/wrong token
  returns a plain `404` (not 401/403), on purpose. See
  [`adr/0014`](./docs/adr/0014-metrics-prometheus-cardinality-slo.md) and
  [`adr/0018`](./docs/adr/0018-metrics-endpoint-protection.md).
- **Traces** — OpenTelemetry, off by default (`OTEL_ENABLED=false`). When on,
  the SDK loads via `node --import ./dist/instrumentation.js` **before** Nest
  boots, so http/express/pg/ioredis auto-instrumentation attaches before
  those modules load. Traces export to an OTel Collector, which forwards to
  Jaeger. See [`adr/0015`](./docs/adr/0015-tracing-opentelemetry-collector-jaeger.md).
- **Errors** — Sentry (`@sentry/nestjs`), off unless `SENTRY_DSN` is set;
  reuses the app's own OTel SDK (`skipOpenTelemetrySetup`) instead of
  starting a second one. See
  [`adr/0016`](./docs/adr/0016-error-tracking-sentry.md).

The observability stack (Collector + Prometheus + Grafana + Jaeger) is
local-only ([`adr/0017`](./docs/adr/0017-observability-local-only.md)),
brought up on demand alongside the core stack:

```bash
docker compose --profile observability up -d
```

| Service    | Local URL                                      |
| ---------- | ----------------------------------------------- |
| App        | http://localhost:3000 (`/metrics` token-guarded) |
| Prometheus | http://localhost:9090                            |
| Grafana    | http://localhost:3001                            |
| Jaeger UI  | http://localhost:16686                           |

Prometheus, Grafana, and Jaeger bind to `127.0.0.1` only (the app port
follows its own `PORT` mapping, see [Docker](#docker)). New env vars are
listed in [Environment Variables](#environment-variables); the full
rationale and trade-offs for each pillar live in
[`docs/adr/`](./docs/adr) 0013–0018.

## Roadmap

- [x] **Foundation** — NestJS + Drizzle + Postgres + Docker Compose; Auth (JWT + refresh rotation + RBAC); Catalog CRUD + OpenAPI.
- [ ] **Core problems** — Inventory & reservations (oversell protection: optimistic vs pessimistic locking); idempotent `POST /orders`; payment webhooks (signature verification, dedup, reconciliation); Catalog caching + invalidation.
- [ ] **Distributed & reliable** — Saga + Outbox checkout with compensation; queues (retry/backoff/dead-letter); advanced cache invalidation; rate limiting + circuit breaker.
- [ ] **Scale & operate** — Observability (Pino + OpenTelemetry + Sentry); k6 load testing; search; production deployment + CI/CD.

## Documentation

Architecture, standards, and the decision ledger live in [`docs/`](./docs):

- [`docs/project-overview-pdr.md`](./docs/project-overview-pdr.md) — scope, goals, business rules, glossary
- [`docs/system-architecture.md`](./docs/system-architecture.md) — bounded contexts and layering
- [`docs/tech-stack.md`](./docs/tech-stack.md) — technology choices and trade-offs
- [`docs/code-standards.md`](./docs/code-standards.md) — coding conventions
- [`docs/engineering-notes.md`](./docs/engineering-notes.md) — deep-dive engineering notes
- [`docs/adr/`](./docs/adr) — Architecture Decision Records (numbered, append-only)

## License

Private / **UNLICENSED**. All rights reserved.
