# JCool E-commerce Backend

> A single-store e-commerce backend built as a **NestJS modular monolith** with a
> **Domain-Driven Design (DDD)** tactical foundation and **Clean Architecture**
> layering — engineered to explore, and defend, the hard problems of transactional
> commerce (concurrency, idempotency, distributed transactions, caching).

<p>
  <a href="https://github.com/jCool10/jcool-ecommerce-backend/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jCool10/jcool-ecommerce-backend/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white">
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
    - [Cart — `/cart`](#cart--cart-bearer)
    - [Order — `/orders`](#order--orders-bearer)
    - [Payment — `/orders/:id/pay`, `/webhooks/payment`](#payment--ordersidpay-webhookspayment)
    - [Health \& Metrics — `/health`, `/metrics`](#health--metrics--health-metrics)
  - [Database \& Migrations](#database--migrations)
  - [Testing](#testing)
  - [Available Scripts](#available-scripts)
  - [Docker](#docker)
  - [Observability](#observability)
  - [Design notes](#design-notes)
  - [Operations](#operations)
  - [Roadmap](#roadmap)
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
  - Scratch space by design: no stock reservation at add-to-cart (that is Order/Inventory, at checkout), and an item whose product was archived after it was added stays in the cart, flagged `isActive: false`.
- **Order**
  - Create an order from the current cart: each line's name and price are **snapshotted** into the order — a later Catalog price change never alters a placed order's total (the order is the transaction source of truth).
  - A pure, table-driven **state machine** — every legal edge lives in one table (`DRAFT → PENDING | CANCELLED`, `PENDING → PAID | FAILED | EXPIRED | CANCELLED`), and an illegal transition is rejected with `409` from a single `assertTransition` rather than from an `if` in each use case.
  - Checkout runs in **one transaction**: the order is persisted at `PENDING`, stock is held, the `order.placed` event is appended to the **transactional outbox**, and the idempotency result is frozen — all four commit or roll back together, so a stock shortfall leaves no order, no event, and no key to block a retry.
  - **Transactional outbox** (`src/shared/messaging/`, see [Design notes](#design-notes)): every order event (`order.placed` from checkout, `order.paid` / `order.failed` / `order.expired` from finalization) is written by the same transaction as the change it describes — never a second write that could be lost after a commit or orphaned by a rollback. The W3C `traceparent` is captured on each row so a consumer can continue the producer's trace across the queue boundary.
  - **Relay → queue → idempotent consumer**: a scheduler polls `published_at IS NULL` with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ and marks the row published **in one transaction** — at-least-once, safe on every replica without leader election. The worker then claims `message_id = outbox.id` in an `inbox` table (unique on `(consumer, message_id)`) and runs the handler **in that same transaction**, which turns at-least-once delivery into an **exactly-once effect**: a redelivery loses the claim and does nothing, and a handler that fails takes its claim with it so the redelivery does the work. Handlers are audit-only by design — the emitting transaction already applied the effect, so reacting again would apply it twice.
- **Inventory**
  - **Stock reservations** behind a published `StockReservation` port: Order calls `reserve(tx, …)` inside its own checkout transaction, so the hold and the order commit or roll back together — a shortfall leaves no order at all.
  - Two interchangeable concurrency strategies under one port, selected by `INVENTORY_LOCK_STRATEGY`: **pessimistic** (`SELECT … FOR UPDATE`) and **optimistic** (version CAS with bounded retry + jittered backoff). A genuine shortfall never consumes a retry — only a lost version race does.
  - Holds carry a TTL (`INVENTORY_RESERVATION_TTL`); an unpaid hold past its deadline is reclaimed by the reservation sweep, which expires the order and releases the stock in one transaction.
- **Payment**
  - Checkout sessions through a `PaymentGatewayPort` — Stripe is the coded adapter; a fake signer adapter implements the same port so the webhook path is exercised in e2e without Stripe's signing key.
  - **Webhook sink** with HMAC-SHA256 signature verification and a timestamp tolerance window (replay defense), plus a `webhook_events` table that dedups a redelivered event before it can settle an order twice.
  - **Reconciliation sweep** polls the gateway for orders stuck `PENDING` past `ORDER_STALE_THRESHOLD_SEC` — the webhook's counterpart, driving the same `FinalizeOrderUseCase`, so a webhook that never arrives is not a stuck order.
  - The gateway is fronted by a **circuit breaker** with its own timeout: it is the one dependency on someone else's network, so it is the one whose slowness could exhaust our request slots.
- **Platform**
  - **Sharding-ready user ids** (see [Design notes](#design-notes)): every user-context id is a **UUIDv8** (RFC 9562 §5.8) carrying a 12-bit routing bucket derived by **HMAC** from the same normalized email the `UNIQUE(email)` index sees — a future `users` shard split routes from the id alone, with no lookup table, and email uniqueness survives the split. HMAC rather than a plain hash because `users.id` is public: an unkeyed digest would turn every published id into an offline email-confirmation oracle. Token rows copy the bucket out of their owner's id, so a user and everything they own land on the same shard. `IDENTITY_BUCKET_KEY` keys the HMAC and is **permanent — never rotate it**; its fingerprint is auto-pinned in the database on first boot and a later boot under a different key is refused. A `CHECK` on the version+variant nibbles of the four user-context primary keys rejects a non-v8 id from **any** writer, raw SQL included. The generator is **single-writer** — see the replica gate under [Docker](#docker).
  - **Security headers** via `helmet` (HSTS, `X-Content-Type-Options: nosniff`, frameguard, no `X-Powered-By`) and a **configurable CORS** allow-list (off by default — same-origin only; opt in via `CORS_ORIGINS`).
  - **OpenAPI / Swagger** docs, config-gated (on in dev, off in prod unless enabled).
  - **Retention sweeps** on one hourly timer, one per table, isolated per sweep so a broken table cannot cost the other six their tick. Every window is sized by what still has to be able to **retry** against the row: an unpublished outbox row is never collected at any age, a `COMPLETED` idempotency key survives until its TTL because it is the response a retry replays, an inbox claim must outlive the queue's redelivery horizon (**boot fails** if it does not, since a swept claim turns a retry into a second effect), and a revoked refresh token outlives an expired one because it is what reuse detection matches against. `reservations` is deliberately excluded — that is the reservation sweep's state machine, not retention. Consequently `queue:replay-dlq` now asks the `inbox` before replaying, and refuses a message it cannot prove was never applied.
  - **Liveness / readiness** health checks (Terminus) probing Postgres and Redis.
  - **Fail-fast config**: the environment schema is validated at boot; a missing or invalid var crashes the process immediately.
  - Global validation pipe (whitelist + reject unknown fields) and a unified HTTP exception filter.
  - Graceful shutdown hooks (drains the Postgres pool on `SIGTERM`/`SIGINT`).

All six bounded contexts listed under [Architecture](#bounded-contexts) are implemented; nothing
below is a stub. What is deliberately *not* here — shipping addresses, tax, discounts, fulfilment
states, product variants beyond the SKU, user profiles — is cut on purpose, not pending.

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
- `src/shared/rbac/` — interface-level RBAC vocabulary (`Role`, `@Roles`, `RolesGuard`, `@Public`, and `@CurrentUser`/`AuthenticatedUser` — the principal `JwtStrategy` attaches to the request), usable by any context without importing the User context.

Cross-context edges are constrained by rule, not by count: **no context may import another
context's `domain/` or `infrastructure/`**. `npm run arch:check` fails the build on one that does.
A context's `application/public/` facade is the preferred door, and where an edge goes through
`application/` instead, that is a deliberate published dependency (Payment settles an order only
through Order's exported `FinalizeOrderUseCase` — never Order's tables).

## Tech Stack

| Concern              | Choice                                               |
| -------------------- | ---------------------------------------------------- |
| Language / Framework | **TypeScript** + **NestJS 11** (Node ≥ 22, CI/image on 24) |
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
│   ├── cart/                    # Per-user scratch cart (live Catalog pricing)
│   ├── order/                   # Order + state machine (price snapshot, checkout in one tx)
│   ├── inventory/               # Stock levels + reservations (pessimistic | optimistic)
│   └── payment/                 # Gateway sessions, webhook sink, reconciliation sweep
└── shared/
    ├── kernel/                  # Framework-free DDD building blocks
    ├── rbac/                    # Role + @Roles + guard + @Public + @CurrentUser
    ├── config/                  # Env schema validation + typed config
    ├── health/                  # Liveness/readiness indicators
    ├── identity/                # UUIDv8 codec + HMAC routing bucket
    ├── messaging/               # Transactional outbox + relay + idempotent consumer
    ├── observability/           # Logging, metrics, tracing, error tracking
    ├── resilience/              # Circuit-breaker factory
    ├── infrastructure/
    │   ├── database/            # Drizzle module, schema barrel, migrations, seed
    │   └── redis/               # Redis module + service
    └── interface/filters/       # Global HTTP exception filter
test/                            # e2e config, Testcontainers setup, load mixes
```

## Getting Started

### Prerequisites

- **Node.js ≥ 22** and npm (`.nvmrc`, CI and the Docker image all pin **24**)
- **Docker** + **Docker Compose** (for Postgres and Redis)

### 1. Install dependencies

```bash
npm ci
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`. Two secrets need a real value (≥ 32 chars each), and they fail differently:

```bash
# generate a secure value — run once per variable, never reuse one value for both
openssl rand -base64 48
```

- `IDENTITY_BUCKET_KEY` is left **unset** in the template, so boot fails until you set it. It is
  also **permanent**: it keys the routing bucket carried inside every user id, so changing it later
  orphans every existing account from the shard holding its rows. Store it in the secret manager
  and back it up alongside the database. Provisioning it is a routine, not a copy-paste — the
  database pins whatever key boots first and holds every later boot to that fingerprint, so a wrong
  key on day one is caught by process, not by code:

  1. generate it with the CSPRNG above. The `≥ 32` check gates length, not entropy: a memorable
     passphrase passes it and is still brute-forceable from a handful of self-registered accounts.
  2. store it in that environment's secret manager — never in the repo, never baked into the image.
  3. boot once against an empty database.
  4. match the startup line `Pinned identity bucket key …` against the fingerprint you expect, and
     keep it with the key. That line prints only on the boot that *writes* the pin — a boot against
     an already-pinned database is silent — so do this on the first one. Every later boot **against
     a reachable database** is then refused unless the key still produces that fingerprint; if the
     database cannot be reached the check is logged and skipped, which costs nothing because no id
     is minted while it is down.
- `JWT_ACCESS_SECRET` ships a **git-public dev placeholder** that is long enough to pass validation,
  so nothing will stop a deploy that still uses it — anyone who can read this repo could then mint a
  valid access token for any user. Replace it by hand for any shared or production environment.

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
(fail-fast). Template lives in [`.env.example`](./.env.example). The schema is
[`src/shared/config/env.validation.ts`](./src/shared/config/env.validation.ts); the defaults below
are applied in [`configuration.ts`](./src/shared/config/configuration.ts). Every variable the schema
declares has a row here — the tables are grouped by the config namespace each one lands in.

**`app`**

| Variable                   | Required | Default                 | Description                                                                                                             |
| -------------------------- | :------: | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 |   Yes    | —                       | `development` \| `test` \| `production`                                                                                 |
| `PORT`                     |    No    | `3000`                  | HTTP port (1–65535)                                                                                                     |
| `SWAGGER_ENABLED`          |    No    | on (off in prod)        | Serve OpenAPI docs at `/docs`                                                                                           |
| `COOKIE_SECURE`            |    No    | on in prod              | `Secure` flag on auth cookies (override for TLS-proxy staging)                                                          |
| `CORS_ORIGINS`             |    No    | — (off)                 | Comma-separated CORS allow-list; empty = same-origin only                                                               |
| `APP_PUBLIC_URL`           |    No    | `http://localhost:3000` | Base URL for links in outbound email                                                                                    |
| `TRUST_PROXY`              |    No    | — (off)                 | Express `trust proxy` for `req.ip` (rate-limit + audit); hop count, subnet/CSV, or `true`. **Required behind a reverse proxy** |
| `SHUTDOWN_GRACE_PERIOD_MS` |    No    | `0`                     | ms `/health/ready` keeps returning 503 after SIGTERM before the HTTP server closes                                      |

**`log` · `metrics`**

| Variable        | Required | Default                    | Description                                                        |
| --------------- | :------: | -------------------------- | ------------------------------------------------------------------ |
| `LOG_LEVEL`     |    No    | `debug` dev / `info` prod  | pino level: `trace`\|`debug`\|`info`\|`warn`\|`error`               |
| `METRICS_TOKEN` |    No    | — (open dev / hidden prod) | Bearer token for `GET /metrics` (min 16 chars); wrong/missing → 404 |

**`tracing` · `sentry`**

| Variable                      | Required | Default                 | Description                                                           |
| ----------------------------- | :------: | ----------------------- | --------------------------------------------------------------------- |
| `OTEL_ENABLED`                |    No    | `false`                 | Start the OpenTelemetry SDK (read in `instrumentation.ts`, pre-boot)   |
| `OTEL_SERVICE_NAME`           |    No    | `jcool-api`             | `service.name` stamped on every span                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` |    No    | `http://localhost:4318` | OTLP/HTTP base endpoint of the Collector (`/v1/traces` is appended)    |
| `SENTRY_DSN`                  |    No    | — (off)                 | Sentry project DSN; unset → the SDK never initializes                 |
| `SENTRY_TRACES_SAMPLE_RATE`   |    No    | — (errors only)         | Fraction (0–1) sampled for Sentry performance; `0`/absent → no spans   |

**`database` · `redis`**

| Variable                        | Required | Default | Description                                                                                    |
| ------------------------------- | :------: | ------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  |   Yes    | —       | PostgreSQL connection string                                                                   |
| `MIGRATIONS_DIR`                |    No    | —       | Overrides where the migration runner looks for `.sql` files; the Docker image sets it (`/app/migrations`) because it ships no `src/` tree |
| `DB_POOL_MAX`                   |    No    | `10`    | Max app-side pg pool connections (caps the Postgres backends a spike can create)                |
| `DB_POOL_CONNECTION_TIMEOUT_MS` |    No    | `5000`  | Fail a pool acquire after this long (pg's own default `0` = wait forever)                       |
| `DB_POOL_IDLE_TIMEOUT_MS`       |    No    | `10000` | Reap an idle pooled connection after this long                                                  |
| `REDIS_URL`                     |   Yes    | —       | Redis connection string                                                                        |

**`queue` · `outbox`**

| Variable                     | Required | Default | Description                                                                                                     |
| ---------------------------- | :------: | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `QUEUE_PREFIX`               |    No    | `bull`  | BullMQ key prefix — namespaces keys so one Redis can serve several environments                                  |
| `QUEUE_WORKER_ENABLED`       |    No    | `true`  | Consumer kill-switch. Off leaves jobs queued in Redis (no TTL), never lost                                       |
| `QUEUE_WORKER_CONCURRENCY`   |    No    | `5`     | Jobs applied in parallel (1–50). Each holds a pg connection for its transaction — size against `DB_POOL_MAX`     |
| `QUEUE_CONSUMER_ATTEMPTS`    |    No    | `8`     | Deliveries before dead-lettering, the first included (1–10). Backoff doubles, so eight spans roughly two minutes |
| `QUEUE_CONSUMER_BACKOFF_MS`  |    No    | `1000`  | First retry delay; each further one doubles it (100–60000)                                                       |
| `OUTBOX_RELAY_ENABLED`       |    No    | `true`  | Relay kill-switch. Off leaves rows unpublished rather than losing them                                            |
| `OUTBOX_POLL_MS`             |    No    | `1000`  | Relay period (min 100, so a typo cannot make it a busy loop)                                                     |
| `OUTBOX_BATCH_SIZE`          |    No    | `100`   | Rows per tick (1–1000). Also caps how long one transaction holds its row locks                                   |

**`auth` · `identity` · `argon2` · `throttle`**

| Variable                       | Required | Default | Description                                                                                                                                              |
| ------------------------------ | :------: | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`            |   Yes    | —       | HS256 secret, **min 32 chars** (no default)                                                                                                              |
| `IDENTITY_BUCKET_KEY`          |   Yes    | —       | HMAC key for the routing bucket in every user id, **min 32 chars**, CSPRNG-generated. **Permanent — never rotate** (rotating orphans every existing account from its shard); back it up with the database. Its fingerprint is pinned in the DB on first boot — a mismatched key refuses boot (an unreachable DB is logged and skipped) |
| `JWT_ACCESS_TTL`               |    No    | `5m`    | Access-token lifetime                                                                                                                                    |
| `REFRESH_TOKEN_TTL`            |    No    | `7d`    | Refresh-token lifetime                                                                                                                                   |
| `EMAIL_VERIFICATION_TTL`       |    No    | `24h`   | Email-verification token lifetime                                                                                                                        |
| `PASSWORD_RESET_TTL`           |    No    | `1h`    | Password-reset token lifetime                                                                                                                            |
| `AUTH_REQUIRE_VERIFIED_EMAIL`  |    No    | `false` | Refuse login until the email is verified (403 after correct credentials)                                                                                 |
| `ARGON2_MEMORY_COST`           |    No    | `19456` | Argon2id memory cost (KiB) — OWASP minimum                                                                                                               |
| `ARGON2_TIME_COST`             |    No    | `2`     | Argon2id time cost                                                                                                                                       |
| `ARGON2_PARALLELISM`           |    No    | `1`     | Argon2id parallelism                                                                                                                                     |
| `THROTTLE_ENABLED`             |    No    | `true`  | Rate limiting on/off (`false` for load tests and e2e)                                                                                                     |

**`payment`**

| Variable                        | Required | Default                                                              | Description                                                                                       |
| ------------------------------- | :------: | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER`              |    No    | `stripe`                                                             | Asserted, not dispatched on: Stripe is the only adapter, so DI never branches. Any other value fails at boot |
| `PAYMENT_WEBHOOK_SECRET`        |    No    | —                                                                    | Webhook HMAC secret (min 16 chars). Absent → the Stripe adapter refuses to construct (fail-fast)   |
| `PAYMENT_WEBHOOK_TOLERANCE_SEC` |    No    | `300`                                                                | Timestamp tolerance for webhook replay defense                                                     |
| `STRIPE_SECRET_KEY`             |    No    | —                                                                    | Live Stripe key (`sk_test_…`/`sk_live_…`). Unset → the adapter stays on its network-free coded path |
| `STRIPE_SUCCESS_URL`            |    No    | `http://localhost:3000/payments/success?session_id={CHECKOUT_SESSION_ID}` | Post-checkout success redirect (`{CHECKOUT_SESSION_ID}` is Stripe's own placeholder)           |
| `STRIPE_CANCEL_URL`             |    No    | `http://localhost:3000/payments/cancel`                              | Post-checkout cancel redirect                                                                      |

**`reconcile` · `reservationSweep`**

| Variable                        | Required | Default | Description                                                                                                     |
| ------------------------------- | :------: | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `RECONCILE_ENABLED`             |    No    | `true`  | Reconciliation sweep kill-switch (off for e2e, which drives the use case directly)                               |
| `RECONCILE_INTERVAL_MS`         |    No    | `60000` | Sweep period (min 1000)                                                                                          |
| `RECONCILE_BATCH_SIZE`          |    No    | `50`    | Orders per tick (1–500) — bounds the gateway round-trips one tick can fan out                                     |
| `ORDER_STALE_THRESHOLD_SEC`     |    No    | `120`   | Minimum age before a `PENDING` order is polled; below it the webhook is probably still in flight                 |
| `ORDER_TTL_SEC`                 |    No    | `900`   | Age after which an unsettled `PENDING` order is expired and its stock released (matches the reservation TTL)     |
| `RESERVATION_SWEEP_ENABLED`     |    No    | `true`  | Reservation-expiry sweep kill-switch                                                                             |
| `RESERVATION_SWEEP_INTERVAL_MS` |    No    | `60000` | Sweep period (min 1000)                                                                                          |
| `RESERVATION_SWEEP_BATCH_SIZE`  |    No    | `50`    | Reservation rows per tick (1–500) — each distinct order costs a finalize transaction                              |
| `RESERVATION_SWEEP_GRACE_SEC`   |    No    | `900`   | Extra age past a hold's expiry before this sweep claims it, so the gateway-driven reconcile always gets there first |

**`retention`** — one hourly timer driving seven independent table sweeps. Every window is sized by
what still has to be able to **retry** against the row, never by disk; shortening one loses a
guarantee, not history. Two are enforced floors rather than preferences: `RETENTION_INBOX_DAYS` must
outlive the queue's 7-day failed-job retention or a redelivery applies its effect twice (**the app
refuses to boot** below it), and a revoked refresh token is kept far longer than an expired one
because it is what reuse detection matches against. `reservations` is deliberately **not** swept —
those rows are released by the reservation-expiry sweep above, which is a state machine, not
retention. See [RUNBOOK — Retention sweeps](./RUNBOOK.md#retention-sweeps) for the full rule table,
the horizon arithmetic, and the measured query plans.

| Variable                            | Required | Default   | Description                                                                                            |
| ----------------------------------- | :------: | --------- | ------------------------------------------------------------------------------------------------------ |
| `RETENTION_ENABLED`                 |    No    | `true`    | Kill-switch for all seven sweeps (off for e2e, which drives them directly)                             |
| `RETENTION_INTERVAL_MS`             |    No    | `3600000` | Tick period (min 1000) — this reclaims a backlog, it does not keep up with a request                    |
| `RETENTION_BATCH_SIZE`              |    No    | `500`     | Rows DELETEd per sweep per tick (1–10000); a sweep that fills its batch every tick warns                |
| `RETENTION_SWEEP_TIMEOUT_MS`        |    No    | `30000`   | How long the scheduler waits for one sweep (min 100). Ends the wait, not the DELETE                     |
| `RETENTION_IDEMPOTENCY_GRACE_SEC`   |    No    | `3600`    | Slack past a key's own `expires_at` (clock skew only — the TTL is already the retry window)             |
| `RETENTION_AUTH_TOKEN_GRACE_DAYS`   |    No    | `7`       | Days past expiry/consumption before a verification or reset token is collected                          |
| `RETENTION_REFRESH_TOKEN_GRACE_DAYS`|    No    | `30`      | Days a **revoked** refresh token is kept (min 30) — the reuse-detection window                          |
| `RETENTION_OUTBOX_DAYS`             |    No    | `30`      | Days a **published** outbox row is kept (min 1). Unpublished rows are never collected, at any age       |
| `RETENTION_INBOX_DAYS`              |    No    | `30`      | Days an inbox claim is kept (min 7, and must exceed the queue's redelivery horizon)                     |
| `RETENTION_WEBHOOK_EVENT_DAYS`      |    No    | `30`      | Days a webhook event is kept (min 14) — sized by the **gateway's** redelivery window, not the queue's   |

**`catalog` · `cache` · `search`**

| Variable                  | Required | Default                  | Description                                                                                              |
| ------------------------- | :------: | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `CATALOG_CACHE_TTL_SEC`   |    No    | `60`                     | Catalog's fresh window. Total staleness after a missed invalidation is this **plus** the stale window and jitter |
| `CACHE_SOFT_TTL_SEC`      |    No    | `60`                     | How long a cached value is served without question (min 1)                                                |
| `CACHE_STALE_WINDOW_SEC`  |    No    | `30`                     | How much longer it may be served while a rebuild runs behind it; `0` switches off stale-serving           |
| `CACHE_TTL_JITTER_SEC`    |    No    | `10`                     | Random spread on each key's expiry, so keys written in one wave do not expire in one wave                 |
| `CACHE_LOCK_LEASE_MS`     |    No    | `5000`                   | Rebuild-lock lease; must stay above the p99 rebuild or a second holder gets in and the herd returns       |
| `CACHE_LOCK_WAIT_MS`      |    No    | `500`                    | How long a reader waits for the lock holder's value before reading through to Postgres; `0` opts out       |
| `SEARCH_ENABLED`          |    No    | `false`                  | Catalog search kill-switch. Off unless `true` — the index is a derived read path, never required to boot   |
| `SEARCH_URL`              |    No    | `http://localhost:7700`  | Search engine base URL                                                                                    |
| `SEARCH_API_KEY`          |    No    | — (keyless)              | Search engine master key (min 16 chars where set)                                                         |

**`resilience.breaker` · `inventory`**

| Variable                           | Required | Default       | Description                                                                                             |
| ---------------------------------- | :------: | ------------- | --------------------------------------------------------------------------------------------------------- |
| `BREAKER_ENABLED`                  |    No    | `true`        | Circuit-breaker kill-switch. Off makes every guarded call a direct pass-through — and drops the timeout too |
| `BREAKER_TIMEOUT_MS`               |    No    | `3000`        | How long one outbound call may run before it is abandoned and counted as a failure (min 100)             |
| `BREAKER_ERROR_THRESHOLD_PCT`      |    No    | `50`          | Failure share that opens the circuit (1–99; capped so a configured breaker cannot in fact be off)         |
| `BREAKER_RESET_TIMEOUT_MS`         |    No    | `10000`       | How long the circuit stays open before one trial call (min 100)                                          |
| `BREAKER_ROLLING_WINDOW_MS`        |    No    | `10000`       | Window the failure share is measured over — the breaker's memory (min 1000)                              |
| `BREAKER_VOLUME_THRESHOLD`         |    No    | `5`           | Calls the window needs before the share counts, so one failure on a quiet route cannot read as 100%      |
| `INVENTORY_LOCK_STRATEGY`          |    No    | `pessimistic` | `pessimistic` (`SELECT … FOR UPDATE`) or `optimistic` (version CAS + retry)                              |
| `INVENTORY_RESERVATION_TTL`        |    No    | `15m`         | How far ahead a `HELD` reservation stamps `expires_at`                                                   |
| `INVENTORY_OPTIMISTIC_MAX_RETRIES` |    No    | `3`           | Re-CAS budget after a lost version race (0–10; `0` = never retry). A real shortfall never consumes one   |
| `INVENTORY_OPTIMISTIC_BACKOFF_MS`  |    No    | `20`          | Base backoff between optimistic retries; grows `2^attempt` with jitter                                   |

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

| Method | Path                  | Auth   | Description                                                                 |
| ------ | --------------------- | ------ | --------------------------------------------------------------------------- |
| `GET`  | `/products`           | Public | List products (paginated; optional `categorySlug`, `q`)                     |
| `GET`  | `/products/search`    | Public | Full-text search via the Meilisearch index (`q`, paginated, `categorySlug`) |
| `GET`  | `/products/:idOrSlug` | Public | Product detail by id or slug (`404` if unknown or not `ACTIVE`)             |

`/products/search` reads the **derived** search index, not Postgres, and is declared before
`:idOrSlug` so a product slugged `search` cannot claim the path. It is served only when
`SEARCH_ENABLED=true`; the index is rebuilt with `npm run search:reindex`.

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

| Method | Path             | Description                                                                                                                     |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/orders`        | Checkout the current cart. Requires an `Idempotency-Key` header; retrying with the same value replays the first result instead of creating a second order. `400` empty/unpurchasable cart or missing key, `409` key in progress or insufficient stock, `422` key reused with a different request |
| `GET`  | `/orders`        | List the current user's orders                                                                                                  |
| `GET`  | `/orders/:id`    | View one order (`404` if unknown or owned by another user)                                                                      |
| `POST` | `/orders/:id/pay` | Open a gateway checkout session for the order. `404` if not found/not the caller's, `409` if the order is not `PENDING` or already has an active payment |

There is no separate "place" call: `POST /orders` goes **DRAFT → PENDING inside one transaction**,
which is what lets the order, its stock hold, its `order.placed` outbox event and its idempotency
result commit or roll back together — a stock shortfall leaves no order, no event, and no key
blocking the retry. Settlement does the same for the status flip, the stock resolution, and the
matching `order.paid` / `order.failed` / `order.expired` / `order.cancelled` event.

`order.cancelled` is the one of those four with no caller yet: the transition, the domain event and
the outbox mapping all exist (`finalize-order.use-case.ts:21`), but nothing invokes them because
there is no cancel route. Cancellation is a route away, not a mechanism away.

Every edge in the state machine is wired: `DRAFT → PENDING | CANCELLED` and
`PENDING → PAID | FAILED | EXPIRED | CANCELLED`. `PAID`, `FAILED`, `EXPIRED` and `CANCELLED` are
terminal — the guard that turns an at-least-once webhook into an exactly-once effect. `version` is
a reserved column: the aggregate is protected by a row lock, not by the optimistic counter.

### Payment — `/orders/:id/pay`, `/webhooks/payment`

| Method | Path                | Auth              | Description                                                                                            |
| ------ | ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `POST` | `/orders/:id/pay`   | Bearer            | Open a gateway checkout session (see the Order table above); throttled per authenticated user as well as per IP |
| `POST` | `/webhooks/payment` | HMAC signature    | Gateway event sink. `200` with `{ status: processed \| duplicate \| skipped \| ignored }`; `401` on an invalid signature or a timestamp outside the tolerance window |

The webhook is `@Public()` because its caller is the gateway, not a user — it authenticates with an
**HMAC-SHA256 signature over the raw request bytes** (which is why the app boots with
`rawBody: true`; the JSON parser would re-serialize and break the signature). A redelivered event
is deduped by `webhook_events` before it can settle an order twice, and it is exempt from both
throttle tiers so a burst of legitimate gateway retries is never rate-limited away.

### Health & Metrics — `/health`, `/metrics`

| Method | Path            | Auth                | Description                                         |
| ------ | --------------- | ------------------- | --------------------------------------------------- |
| `GET`  | `/health/live`  | Public              | Liveness (no dependencies checked)                  |
| `GET`  | `/health/ready` | Public              | Readiness (503 if Postgres or Redis is unreachable; never rate limited, so a Redis outage is reported rather than masked by the guard) |
| `GET`  | `/metrics`      | `METRICS_TOKEN`     | Prometheus text format. A missing or wrong token returns a plain `404`, not `401`/`403` — the endpoint does not admit it exists |

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

| Script                        | Purpose                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run start:dev`           | Run in watch mode                                                                           |
| `npm run start:prod`          | Run the compiled output (`node --import ./dist/instrumentation.js dist/main`)                |
| `npm run build`               | Compile with the Nest SWC builder                                                            |
| `npm run typecheck`           | `tsc --noEmit` — the separate type gate (SWC transpiles without checking)                    |
| `npm run lint` / `lint:check` | ESLint with / without `--fix` (CI must report, not mutate)                                   |
| `npm run format`              | Prettier                                                                                     |
| `npm run arch:check`          | Enforce architecture boundaries (dependency-cruiser)                                          |
| `npm run alerts:check` / `alerts:test` | Prometheus alert rules parse, and fire (and clear) on the timelines they claim to    |
| `npm test` / `test:cov`       | Unit tests / with coverage                                                                    |
| `npm run test:e2e`            | Integration tests (Testcontainers Postgres + Redis) — needs Docker                            |
| `npm run db:generate`         | Generate a migration from schema changes                                                      |
| `npm run db:migrate`          | Apply pending migrations (drizzle-kit, local)                                                 |
| `npm run db:migrate:prod`     | Apply pending migrations from the compiled CLI — the image's release command                  |
| `npm run db:studio`           | Open Drizzle Studio                                                                           |
| `npm run db:seed`             | Seed sample data                                                                              |
| `npm run search:reindex`      | Rebuild the Meilisearch index from Postgres                                                   |
| `npm run queue:replay-dlq`    | Inspect the dead-letter queue; `-- --apply` to replay (`:prod` twin runs from `dist/`)        |
| `npm run identity:verify`     | Scan every user row for an id that does not route to its email's bucket                       |
| `npm run load:baseline`       | k6 baseline mix (`load:register:write` / `load:register:dup` for the registration mixes)      |

## Docker

A multi-stage [`Dockerfile`](./Dockerfile) builds a lean image (Node 24 Alpine, non-root user,
prod-only dependencies). The runtime stage copies `dist/` **and** the migration `.sql` files, with
`MIGRATIONS_DIR=/app/migrations` (absolute, because the image carries no `src/` tree for the
CWD-relative default), so the image can apply migrations on its own: `npm run db:migrate:prod`
runs the compiled CLI as a release command, separate from app bootstrap — a failed migration then
stops the rollout instead of crashlooping the app and taking down the version that was serving fine.

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

> **Replica gate — run exactly one app instance.** The id generator holds a fixed node id for the
> whole fleet, so two replicas mint the same `(timestamp, node, sequence)` triples. What that costs
> is narrower than it sounds, and worth stating precisely: the layout is
> `48 ts | 4 ver | 12 bucket | 2 var | 10 node | 12 seq | 40 random`, so **ids stay unique** — 40
> random bits see to that, and no insert fails. What is lost is the *ordered per-writer sequence*,
> and only on the four User-context tables; every other table mints UUIDv7. The real problem is that
> **nothing detects it**: no error, no metric, no failed insert.
>
> `railway.json` sets `numReplicas: 1`, but also `overlapSeconds: 20` — so **every rollout runs two
> instances for ~20s** by design. The gate is a floor on steady state, not a guarantee of
> single-writer at all times. Lifting it properly needs a node-id lease.
>
> The standalone seed and perf scripts mint under a different node id, so one of them may run
> alongside the app — but only one at a time, since two of them collide with each other for the
> same reason.

## Observability

Three pillars + error tracking, wired **around** the Clean Architecture core —
`domain`/`application` import none of this, and `npm run arch:check` fails the
build if they start to:

- **Logs** — structured JSON via `nestjs-pino`. Every log line of a request
  carries the same `requestId` (correlation id, via `nestjs-cls` +
  `AsyncLocalStorage`), also echoed back as the `x-request-id` response
  header.
- **Metrics** — `GET /metrics` (Prometheus text format): default process
  metrics, RED HTTP metrics (`route` as a path template, never a raw id),
  and business counters. Guarded by `METRICS_TOKEN` — a missing/wrong token
  returns a plain `404` (not 401/403), on purpose: a 401 would confirm the
  endpoint exists to anyone probing for it.
- **Traces** — OpenTelemetry, off by default (`OTEL_ENABLED=false`). When on,
  the SDK loads via `node --import ./dist/instrumentation.js` **before** Nest
  boots, so http/express/pg/ioredis auto-instrumentation attaches before
  those modules load. Traces export to an OTel Collector, which forwards to
  Jaeger.
- **Errors** — Sentry (`@sentry/nestjs`), off unless `SENTRY_DSN` is set;
  reuses the app's own OTel SDK (`skipOpenTelemetrySetup`) instead of
  starting a second one, which would double every span.

The observability stack (Collector + Prometheus + Grafana + Jaeger) is
**local-only** — deliberately not deployed, because a hosted collector is an
operational commitment this project does not need to make its point. It is
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
follows its own `PORT` mapping, see [Docker](#docker)). The env vars are
listed in [Environment Variables](#environment-variables); the reasoning
behind each pillar is in [Design notes](#design-notes).

## Design notes

Why the load-bearing decisions are what they are. Each is a decision that would otherwise have to be
re-derived from the code — kept here, next to the code, rather than in a separate ledger that drifts.

### Boundaries are enforced, not documented

`npm run arch:check` (dependency-cruiser, [`.dependency-cruiser.cjs`](./.dependency-cruiser.cjs))
fails the build when `domain` imports a framework or a DB driver, when `application` imports
`infrastructure` or `interface`, or when one context reaches into another's `domain`/`infrastructure`.
A convention nobody can violate accidentally is worth more than a document everybody agrees with.

`shared/` is the leaf layer every context imports, so it may not import a context back — that would
turn it into a hidden context. Two composition roots are exempt because they exist precisely to wire
contexts together: `shared/messaging` registers context handlers into DI, and the schema barrel
collects every context's tables for the migrator.

`domain`/`application` are additionally barred from importing **any** telemetry (OTel, pino,
prom-client, Sentry). Observability reaches the core only through a pure metrics port. The rule is
mechanical because the leak is easy: the `shared/observability` barrel transitively pulls
`@opentelemetry/api`, so one stray `withSpan` import would put a tracing dependency in a domain
entity.

### Transactional outbox + inbox

An event written by a second connection after the business transaction commits can be lost (the
process dies in between) or orphaned (the transaction rolls back but the event went out). So events
are rows, written by the **same transaction** as the change they describe. A relay polls
`published_at IS NULL` with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ and marks the row published
in one transaction — at-least-once, and safe on every replica without leader election.

The consumer side closes the loop: the worker claims `message_id = outbox.id` in an `inbox` table
(unique on `(consumer, message_id)`) and runs the handler **in that same transaction**, which turns
at-least-once delivery into an exactly-once *effect*. A redelivery loses the claim and does nothing;
a handler that throws takes its claim down with it, so the redelivery does the work.

Inbox rows are never deleted on a schedule: an id absent from that table is the only proof a message
has not been applied, so removing one silently re-enables a duplicate.

### Sharding-ready user ids

Every user-context id is a UUIDv8 (RFC 9562 §5.8) laid out as
`48 ts_ms | 4 ver | 12 bucket | 2 var | 10 node | 12 seq | 40 random`. The 12-bit routing bucket is
derived by **HMAC** from the same normalized email the `UNIQUE(email)` index sees, so a future
`users` shard split routes from the id alone — no lookup table — and email uniqueness survives it.

HMAC rather than a plain hash because `users.id` is public: an unkeyed digest would turn every
published id into an offline oracle for "does this address have an account here". `IDENTITY_BUCKET_KEY`
keys it and is **permanent**; the database pins its fingerprint on first boot and refuses a later
boot under a different key.

The layout is enforced in the **application**, not the database: `uuid-v8.codec.ts` rejects a
non-v8 id on decode, and the only writer is the app. A `CHECK` on the version and variant nibbles of
the four user-context primary keys would close that to raw SQL as well; it is not there today, and
the honest reason is that nothing writes those tables but this process.

### Observability, and why the core cannot see it

- **Logs** are the join key. One `requestId` per request via `nestjs-cls` + `AsyncLocalStorage`,
  stamped on every line and echoed as `x-request-id`, so a support ticket quoting a header value
  reaches the exact lines that served it. Email is deliberately **not** in the shared redaction list:
  the auth audit trail is supposed to record it, and the external Sentry sink strips it separately —
  redacting it globally would blind the audit log to make the Sentry sink redundant.
- **Metrics** carry `route` as a path template, never a raw id. Cardinality is a cost that only shows
  up later, in a Prometheus that has stopped being queryable, so the rule is enforced at the one
  helper both the interceptor and the collector call. Metric emission can never throw into a business
  flow: a telemetry failure must not become an order failure.
- **`/metrics` answers `404`**, not `401`, to a missing or wrong token. A `401` confirms the endpoint
  is there; a `404` says nothing to a scanner.
- **Tracing** loads via `node --import ./dist/instrumentation.js`, *before* Nest boots, because
  auto-instrumentation has to patch `http`/`express`/`pg`/`ioredis` before those modules are
  required. It is off by default: no Collector is deployed.
- **Sentry** reuses the app's own OTel SDK (`skipOpenTelemetrySetup`) rather than starting a second
  one, which would duplicate every span.

### Vitest + SWC

Vitest is the runner; the transform is **SWC**, not Vitest's default esbuild, because esbuild does
not emit `emitDecoratorMetadata` — which NestJS DI needs, so `Test.createTestingModule()` would fail
at the app layer. SWC is transpile-only, which is why `tsc --noEmit` is a separate gate rather than
something the test run covers.

### API versioning

There is no `/v1` prefix, and that is a policy, not an omission: changes are **additive-only**, and a
breaking change would introduce `/v2` rather than reinterpret an existing path. A version prefix
added before the first breaking change is a prefix that only ever costs typing.

## Operations

[`RUNBOOK.md`](./RUNBOOK.md) holds the procedures an operator needs and the code cannot express:
rebuilding the search index, backup/restore (including what happens if a dump is restored into a
database pinned to a different `IDENTITY_BUCKET_KEY` fingerprint), and replaying the dead-letter
queue.

## Roadmap

- [x] **Foundation** — NestJS + Drizzle + Postgres + Docker Compose; Auth (JWT + refresh rotation + RBAC); Catalog CRUD + OpenAPI.
- [x] **Core problems** — Inventory & reservations (oversell protection: optimistic vs pessimistic locking); idempotent `POST /orders`; payment webhooks (signature verification, dedup, reconciliation); Catalog caching + invalidation.
- [x] **Distributed & reliable** — Saga + Outbox checkout with compensation; queues (retry/backoff/dead-letter); advanced cache invalidation; rate limiting + circuit breaker.
- [x] **Scale & operate** — Observability (Pino + OpenTelemetry + Sentry); k6 load testing; search (Meilisearch); DB indexing; CI on GitHub Actions.
- [x] **Deploy** — CD to Railway. CI green on `main` → `workflow_run` triggers [`cd.yml`](./.github/workflows/cd.yml) → `railway up` builds the image → Railway's `preDeployCommand` applies migrations → the traffic switch is gated on `/health/ready` from inside the network → the workflow then smokes the **public** URL, which covers what the internal gate cannot see (domain, TLS, edge routing). Behaviour is still evidenced by integration specs against real Postgres and Redis (`npm run test:e2e`), now in addition to a live URL rather than instead of one.

## License

Private / **UNLICENSED**. All rights reserved.
