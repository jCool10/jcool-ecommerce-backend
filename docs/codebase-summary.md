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

CLIs (the api's migrate, DLQ replay, search reindex and storage verify also have a `:prod` twin that runs the compiled `dist/` file; the id-service floor lift only ever runs compiled — see [`README.md#scripts`](../README.md#scripts) for the `pnpm` names):

| CLI | File |
| --- | --- |
| api migrate | [`apps/api/src/shared/infrastructure/database/migrate-cli.ts`](../apps/api/src/shared/infrastructure/database/migrate-cli.ts) |
| api seed | [`apps/api/src/shared/infrastructure/database/seed.ts`](../apps/api/src/shared/infrastructure/database/seed.ts) |
| DLQ replay | [`apps/api/src/shared/messaging/queue/replay-dlq.cli.ts`](../apps/api/src/shared/messaging/queue/replay-dlq.cli.ts) |
| search reindex | [`apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts`](../apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts) |
| storage verify | [`apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts`](../apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts) |
| checkout saga workflow bundle (the second half of `pnpm build`) | [`apps/api/src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts`](../apps/api/src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts) |
| id-service floor lift (pre-deploy form: `--if-uninitialized`) | [`apps/id-service/src/lease/lift-floors-cli.ts`](../apps/id-service/src/lease/lift-floors-cli.ts) |
| user-service migrate | [`apps/user-service/src/database/migrate-cli.ts`](../apps/user-service/src/database/migrate-cli.ts) |

## Bounded contexts

Each is a sibling directory under [`apps/api/src/modules`](../apps/api/src/modules), one context per directory (`cart`, `media`, `order`, `payment`, `product`), each split into its own `domain` / `application` / `infrastructure` / `interface` layers. Inside `product`, each layer is split again into `catalog/` and `stock/`, with the published ports in `application/public/`. What each context owns and publishes is the README's [bounded-context table](../README.md#bounded-contexts); this is only the path to open.

## Checkout saga

The saga's decisions are pure domain code in [`apps/api/src/modules/order/domain/checkout-saga.ts`](../apps/api/src/modules/order/domain/checkout-saga.ts); the rest is under [`apps/api/src/modules/order/infrastructure/temporal`](../apps/api/src/modules/order/infrastructure/temporal):

| Concern | File |
| --- | --- |
| Workflow (sandboxed, imports only the contract and the domain) | [`workflows/checkout-saga.workflow.ts`](../apps/api/src/modules/order/infrastructure/temporal/workflows/checkout-saga.workflow.ts) |
| Names, signals, updates, input and activity signatures shared by both sides | [`checkout-saga.contract.ts`](../apps/api/src/modules/order/infrastructure/temporal/checkout-saga.contract.ts) |
| Activities over the order repository and the two participant ports | [`checkout-saga.activities.ts`](../apps/api/src/modules/order/infrastructure/temporal/checkout-saga.activities.ts) |
| Client side, behind `CHECKOUT_SAGA_ENGINE` | [`temporal-checkout-saga.engine.ts`](../apps/api/src/modules/order/infrastructure/temporal/temporal-checkout-saga.engine.ts), port in [`checkout-saga-engine.port.ts`](../apps/api/src/modules/order/application/ports/checkout-saga-engine.port.ts) |
| Worker supervisor and its shutdown step | [`checkout-saga.worker.ts`](../apps/api/src/modules/order/infrastructure/temporal/checkout-saga.worker.ts) |
| Recorded histories the replay spec checks every change against | [`replay-histories/`](../apps/api/src/modules/order/infrastructure/temporal/replay-histories), [`checkout-saga.replay.spec.ts`](../apps/api/src/modules/order/infrastructure/temporal/checkout-saga.replay.spec.ts) |

## Shared / messaging

Cross-context wiring and the outbox/inbox backbone live in [`apps/api/src/shared/messaging`](../apps/api/src/shared/messaging) (outbox, relay, BullMQ queue, inbox, dead-letter replay). It is one of the two composition roots allowed to import across contexts ([`README.md#layering`](../README.md#layering)).

## Schema and migrations

Each Postgres-backed service owns its own schema and migration set against its own Postgres. The id-service has none; its etcd keyspace is defined in [`apps/id-service/src/lease/etcd-lease-keyspace.ts`](../apps/id-service/src/lease/etcd-lease-keyspace.ts):

| Service | Schema barrel | Migrations |
| --- | --- | --- |
| api | [`apps/api/src/shared/infrastructure/database/schema/index.ts`](../apps/api/src/shared/infrastructure/database/schema/index.ts) | [`apps/api/src/shared/infrastructure/database/migrations/`](../apps/api/src/shared/infrastructure/database/migrations/) |
| user-service | [`apps/user-service/src/database/schema.ts`](../apps/user-service/src/database/schema.ts) | [`apps/user-service/src/database/migrations/`](../apps/user-service/src/database/migrations/) |

Migrations are Drizzle-generated (`pnpm db:generate`); the current set is whatever is committed under each `migrations/` directory — list it directly rather than trusting a count here.

## Env schema and config

| Service | Validation + factory |
| --- | --- |
| api | [`apps/api/src/shared/config/env.validation.ts`](../apps/api/src/shared/config/env.validation.ts), [`configuration.ts`](../apps/api/src/shared/config/configuration.ts) |
| id-service | [`apps/id-service/src/config/env.validation.ts`](../apps/id-service/src/config/env.validation.ts), [`configuration.ts`](../apps/id-service/src/config/configuration.ts) |
| user-service | [`apps/user-service/src/config/env.validation.ts`](../apps/user-service/src/config/env.validation.ts), [`configuration.ts`](../apps/user-service/src/config/configuration.ts) |

Every service composes its env schema from shared fragments in [`packages/platform/src/config`](../packages/platform/src/config) (parsers and strict decorators every app's validator builds on). The commented variable references are [`.env.example`](../.env.example) for the api and [`apps/user-service/.env.example`](../apps/user-service/.env.example) for the user-service; see [`README.md#configuration`](../README.md#configuration) for which ones have no default.

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
| Temporal server image, bootstrap and server config | [`infra/temporal`](../infra/temporal) |
| Railway images that bake the config above (Prometheus, Grafana, Loki) and run Elasticsearch and the id-service's etcd | `infra/*/Dockerfile`, e.g. [`infra/etcd/Dockerfile`](../infra/etcd/Dockerfile), [`infra/elasticsearch/Dockerfile`](../infra/elasticsearch/Dockerfile) |

## Scripts

| Where | What lives there |
| --- | --- |
| [`scripts/`](../scripts) | Repo tooling: the CI check on hand-flipped Railway variables, CD's rollout wait, perf-run capture, and the doc diagram build |
| [`apps/api/scripts/`](../apps/api/scripts) | The perf seed behind the load tests (`db:seed:perf`) and a trace-propagation harness |
| [`apps/user-service/scripts/`](../apps/user-service/scripts) | Perf-user and bulk user seeds, the epoch prewarm, DB metrics capture; they mint on the node reserved for scripts, under one lock |

## Docs diagrams

Each diagram's source is a JSON IR in [`docs/diagrams/`](./diagrams), compiled with its light and dark SVG by [`scripts/build-doc-diagrams.mjs`](../scripts/build-doc-diagrams.mjs); how to change one is in [`docs/README.md`](./README.md).

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
| `@jcool/platform` | Nest infrastructure glue, one subpath export per concern (config, db, redis, observability, metrics, error tracking, health, throttler, rbac, mail, resilience, retention, identity, interface) | [`packages/platform/package.json`](../packages/platform/package.json) |
| `@jcool/testing` | Test doubles, dev-only | [`packages/testing/package.json`](../packages/testing/package.json) |
| `apps/id-service` | 63-bit id minting service, under a leased node id | [`apps/id-service/README.md`](../apps/id-service/README.md) |
| `apps/user-service` | Auth/user service | [`apps/user-service/README.md`](../apps/user-service/README.md) |

## Discovery commands

Use these instead of a hand-maintained inventory:

- Workspace packages: read [`pnpm-workspace.yaml`](../pnpm-workspace.yaml), or `pnpm -r list --depth -1`.
- HTTP routes: `/docs` (Swagger UI) on a running instance when `SWAGGER_ENABLED` is on.
- e2e specs: `find apps -name '*.e2e-spec.ts'`.
- System specs: `find apps -name '*.system-spec.ts'`.
