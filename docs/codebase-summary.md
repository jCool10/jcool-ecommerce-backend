# Codebase summary

Navigation only — "where to look for X". For what each context owns, the layering contract and the full directory tree, see [`README.md#project-layout`](../README.md#project-layout) and [`README.md#bounded-contexts`](../README.md#bounded-contexts). Nothing here repeats those.

## Entry points

| App / process | Entry point |
| --- | --- |
| `api` bootstrap | [`apps/api/src/main.ts`](../apps/api/src/main.ts) |
| `api` telemetry preload | [`apps/api/src/instrumentation.ts`](../apps/api/src/instrumentation.ts) |
| `id-service` | [`apps/id-service/src/main.ts`](../apps/id-service/src/main.ts) |
| `user-service` | [`apps/user-service/src/main.ts`](../apps/user-service/src/main.ts) |
| `gateway` | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) (not a Node process) |

CLIs (each also has a `:prod` twin that runs the compiled `dist/` file — see [`README.md#scripts`](../README.md#scripts) for the `pnpm` names):

| CLI | File |
| --- | --- |
| api migrate | [`apps/api/src/shared/infrastructure/database/migrate-cli.ts`](../apps/api/src/shared/infrastructure/database/migrate-cli.ts) |
| api seed | [`apps/api/src/shared/infrastructure/database/seed.ts`](../apps/api/src/shared/infrastructure/database/seed.ts) |
| DLQ replay | [`apps/api/src/shared/messaging/queue/replay-dlq.cli.ts`](../apps/api/src/shared/messaging/queue/replay-dlq.cli.ts) |
| search reindex | [`apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts`](../apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts) |
| storage verify | [`apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts`](../apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts) |
| id-service migrate | [`apps/id-service/src/database/migrate-cli.ts`](../apps/id-service/src/database/migrate-cli.ts) |
| user-service migrate | [`apps/user-service/src/database/migrate-cli.ts`](../apps/user-service/src/database/migrate-cli.ts) |

## Bounded contexts

Each is a sibling directory under [`apps/api/src/modules`](../apps/api/src/modules), one context per directory (`cart`, `media`, `order`, `payment`, `product`), each split into its own `domain` / `application` / `infrastructure` / `interface` layers. Inside `product`, each layer is split again into `catalog/` and `stock/`, with the published ports in `application/public/`. What each context owns and publishes is the README's [bounded-context table](../README.md#bounded-contexts); this is only the path to open.

## Shared / messaging

Cross-context wiring and the outbox/inbox backbone live in [`apps/api/src/shared/messaging`](../apps/api/src/shared/messaging) (outbox, relay, BullMQ queue, inbox, dead-letter replay). It is one of the two composition roots allowed to import across contexts ([`README.md#layering`](../README.md#layering)).

## Schema and migrations

Each service owns its own schema and migration set against its own Postgres:

| Service | Schema barrel | Migrations |
| --- | --- | --- |
| api | [`apps/api/src/shared/infrastructure/database/schema/index.ts`](../apps/api/src/shared/infrastructure/database/schema/index.ts) | [`apps/api/src/shared/infrastructure/database/migrations/`](../apps/api/src/shared/infrastructure/database/migrations/) |
| id-service | [`apps/id-service/src/database/schema.ts`](../apps/id-service/src/database/schema.ts) | [`apps/id-service/src/database/migrations/`](../apps/id-service/src/database/migrations/) |
| user-service | [`apps/user-service/src/database/schema.ts`](../apps/user-service/src/database/schema.ts) | [`apps/user-service/src/database/migrations/`](../apps/user-service/src/database/migrations/) |

Migrations are Drizzle-generated (`pnpm db:generate`); the current set is whatever is committed under each `migrations/` directory — list it directly rather than trusting a count here.

## Env schema and config

| Service | Validation + factory |
| --- | --- |
| api | [`apps/api/src/shared/config/env.validation.ts`](../apps/api/src/shared/config/env.validation.ts), [`configuration.ts`](../apps/api/src/shared/config/configuration.ts) |
| id-service | [`apps/id-service/src/config/env.validation.ts`](../apps/id-service/src/config/env.validation.ts), [`configuration.ts`](../apps/id-service/src/config/configuration.ts) |
| user-service | [`apps/user-service/src/config/env.validation.ts`](../apps/user-service/src/config/env.validation.ts), [`configuration.ts`](../apps/user-service/src/config/configuration.ts) |

Every service composes its env schema from shared fragments in [`packages/platform/src/config`](../packages/platform/src/config) (parsers and strict decorators every app's validator builds on). The complete, commented variable references are [`.env.example`](../.env.example) for the api and [`apps/user-service/.env.example`](../apps/user-service/.env.example) for the user-service; see [`README.md#configuration`](../README.md#configuration) for which ones have no default.

## Test tiers

| Tier | Location |
| --- | --- |
| Unit | co-located `*.spec.ts` next to the code it tests, in every app and package |
| Integration (e2e) | `apps/*/test/integration/*.e2e-spec.ts`; setup/harness in `apps/*/test/setup` (e.g. [`apps/api/test/setup/global-setup.ts`](../apps/api/test/setup/global-setup.ts), [`apps/api/test/setup/test-app.factory.ts`](../apps/api/test/setup/test-app.factory.ts)) |
| System | `*.system-spec.ts` under `apps/gateway/test/` and `apps/id-service/test/system/` — real images on a Docker network, run by `pnpm turbo run test:system --concurrency=1` |
| Load/performance | [`test/load/`](../test/load) (k6 mixes with Prometheus as the authority) and [`k6/`](../k6) |

Discover the current suite rather than trusting a count: `find apps -name '*.e2e-spec.ts'` for integration specs, `find apps -name '*.system-spec.ts'` for system specs. Tier boundaries and coverage-floor rationale are in [`README.md#testing`](../README.md#testing).

## Infra as code

| Concern | Path |
| --- | --- |
| Prometheus alert rules + `promtool` tests | [`infra/prometheus/rules`](../infra/prometheus/rules), [`infra/prometheus/tests`](../infra/prometheus/tests) |
| Grafana dashboards/datasources | [`infra/grafana/provisioning`](../infra/grafana/provisioning) |
| Loki | [`infra/loki/config.yaml`](../infra/loki/config.yaml) |
| OTel Collector | [`infra/otel-collector/config.yaml`](../infra/otel-collector/config.yaml) |
| Elasticsearch (Railway image) | [`infra/elasticsearch/Dockerfile`](../infra/elasticsearch/Dockerfile) |

## CI/CD and deploy config

CI/CD workflows: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/cd.yml`](../.github/workflows/cd.yml), [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml). Railway service topology: [`.railway/railway.ts`](../.railway/railway.ts). Gateway routing: see below. Details and rationale that the YAML/config can't state are in [`deployment-guide.md`](./deployment-guide.md).

## Gateway

[`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) is the routing config (public site + private id-service load balancer); [`apps/gateway/entrypoint.sh`](../apps/gateway/entrypoint.sh) is its container entrypoint.

## Packages

| Package | Role | Owner |
| --- | --- | --- |
| `@jcool/kernel` | Framework-free DDD building blocks | [`packages/kernel/package.json`](../packages/kernel/package.json) |
| `@jcool/id-codec` | Snowflake id layout | [`packages/id-codec/package.json`](../packages/id-codec/package.json) |
| `@jcool/id-generator` | Monotonic id generator, node lease | [`packages/id-generator/package.json`](../packages/id-generator/package.json) |
| `@jcool/auth-verifier` | Access-token verification (every service) | [`packages/auth-verifier/package.json`](../packages/auth-verifier/package.json) |
| `@jcool/metrics-port` | Metrics seam for domain/application code | [`packages/metrics-port/package.json`](../packages/metrics-port/package.json) |
| `@jcool/platform` | Nest infrastructure glue (db, redis, observability, health, throttler, rbac, mail, resilience, retention) | [`packages/platform/package.json`](../packages/platform/package.json) |
| `@jcool/testing` | Test doubles, dev-only | [`packages/testing/package.json`](../packages/testing/package.json) |
| `apps/id-service` | 63-bit id minting service, under a leased node id | [`apps/id-service/README.md`](../apps/id-service/README.md) |
| `apps/user-service` | Auth/user service | [`apps/user-service/README.md`](../apps/user-service/README.md) |

## Discovery commands

Use these instead of a hand-maintained inventory:

- Workspace packages: read [`pnpm-workspace.yaml`](../pnpm-workspace.yaml), or `pnpm -r list --depth -1`.
- HTTP routes: `/docs` (Swagger UI) on a running instance when `SWAGGER_ENABLED` is on.
- e2e specs: `find apps -name '*.e2e-spec.ts'`.
- System specs: `find apps -name '*.system-spec.ts'`.
