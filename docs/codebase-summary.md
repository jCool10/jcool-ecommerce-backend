# Codebase summary

Navigation only — "where to look for X". For what each context owns, the layering contract and the full directory tree, see [`README.md#project-layout`](../README.md#project-layout) and [`README.md#bounded-contexts`](../README.md#bounded-contexts). Nothing here repeats those. Counts of files, tables, migrations, routes and tests are deliberately absent: use the discovery commands at the end.

## Entry points

| App / process | Entry point |
| --- | --- |
| `api` bootstrap | [`apps/api/src/main.ts`](../apps/api/src/main.ts) |
| `api` telemetry preload | [`apps/api/src/instrumentation.ts`](../apps/api/src/instrumentation.ts) |
| `id-service` | [`apps/id-service/src/main.ts`](../apps/id-service/src/main.ts) |
| `user-service` | [`apps/user-service/src/main.ts`](../apps/user-service/src/main.ts) |
| `inventory-service` | [`apps/inventory-service/src/main.ts`](../apps/inventory-service/src/main.ts) |
| `payment-service` | [`apps/payment-service/src/main.ts`](../apps/payment-service/src/main.ts) |
| `order-service` | [`apps/order-service/src/main.ts`](../apps/order-service/src/main.ts) |
| `gateway` | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) (not a Node process) |

CLIs (the api's migrate, DLQ replay, search reindex and storage verify, and the order-service's DLQ replay, also have a `:prod` twin that runs the compiled `dist/` file; the id-service floor lift only ever runs compiled — see [`README.md#scripts`](../README.md#scripts) for the `pnpm` names):

| CLI | File |
| --- | --- |
| api migrate | [`apps/api/src/shared/infrastructure/database/migrate-cli.ts`](../apps/api/src/shared/infrastructure/database/migrate-cli.ts) |
| api seed | [`apps/api/src/shared/infrastructure/database/seed.ts`](../apps/api/src/shared/infrastructure/database/seed.ts) |
| DLQ replay, api (one queue per run, `--queue api-events`) | [`apps/api/src/shared/messaging/queue/replay-dlq.cli.ts`](../apps/api/src/shared/messaging/queue/replay-dlq.cli.ts) |
| DLQ replay, order-service (one queue per run, `--queue order-events`) | [`apps/order-service/src/shared/messaging/replay-dlq.cli.ts`](../apps/order-service/src/shared/messaging/replay-dlq.cli.ts) |
| search reindex | [`apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts`](../apps/api/src/modules/product/infrastructure/catalog/search/reindex.ts) |
| storage verify | [`apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts`](../apps/api/src/shared/infrastructure/storage/verify-storage-orphans.cli.ts) |
| checkout saga workflow bundle (the second half of the order-service's `pnpm build`) | [`apps/order-service/src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts) |
| id-service floor lift (pre-deploy form: `--if-uninitialized`) | [`apps/id-service/src/lease/lift-floors-cli.ts`](../apps/id-service/src/lease/lift-floors-cli.ts) |
| user-service migrate | [`apps/user-service/src/database/migrate-cli.ts`](../apps/user-service/src/database/migrate-cli.ts) |
| inventory-service migrate | [`apps/inventory-service/src/database/migrate-cli.ts`](../apps/inventory-service/src/database/migrate-cli.ts) |
| inventory-service stock seed | [`apps/inventory-service/src/database/seed-stock.ts`](../apps/inventory-service/src/database/seed-stock.ts) |
| inventory-service pre-deploy (migrate, then the seed best effort) | [`apps/inventory-service/src/database/pre-deploy-cli.ts`](../apps/inventory-service/src/database/pre-deploy-cli.ts) |
| payment-service migrate | [`apps/payment-service/src/database/migrate-cli.ts`](../apps/payment-service/src/database/migrate-cli.ts) |
| order-service migrate | [`apps/order-service/src/database/migrate-cli.ts`](../apps/order-service/src/database/migrate-cli.ts) |

## Bounded contexts

Each is a sibling directory under [`apps/api/src/modules`](../apps/api/src/modules), one context per directory (`cart`, `media`, `product`), each split into its own `domain` / `application` / `infrastructure` / `interface` layers. Inside `product`, each layer keeps its code under `catalog/`, with the published port in `application/public/`. The other contexts left the api, each as a service with the same four layers in one module: stock is [`apps/inventory-service/src/modules/inventory`](../apps/inventory-service/src/modules/inventory), payment is [`apps/payment-service/src/modules/payment`](../apps/payment-service/src/modules/payment), and order is [`apps/order-service/src/modules/order`](../apps/order-service/src/modules/order). The order-service reaches stock through [`order-inventory-participant.http-adapter.ts`](../apps/order-service/src/modules/order/infrastructure/order-inventory-participant.http-adapter.ts), payment through [`order-payment-participant.http-adapter.ts`](../apps/order-service/src/modules/order/infrastructure/order-payment-participant.http-adapter.ts), and the api's cart and catalog through [`cart-snapshot.http-adapter.ts`](../apps/order-service/src/modules/order/infrastructure/cart-snapshot.http-adapter.ts) and [`catalog-query.http-adapter.ts`](../apps/order-service/src/modules/order/infrastructure/catalog-query.http-adapter.ts). What each context owns and publishes is the README's [bounded-context table](../README.md#bounded-contexts); this is only the path to open.

## Checkout saga

The saga's decisions are pure domain code in [`apps/order-service/src/modules/order/domain/checkout-saga.ts`](../apps/order-service/src/modules/order/domain/checkout-saga.ts); the order's states and edges are [`order-status.ts`](../apps/order-service/src/modules/order/domain/order-status.ts) and [`order-state-machine.ts`](../apps/order-service/src/modules/order/domain/order-state-machine.ts); the rest is under [`apps/order-service/src/modules/order/infrastructure/temporal`](../apps/order-service/src/modules/order/infrastructure/temporal):

| Concern | File |
| --- | --- |
| Workflow (sandboxed, imports only the contract and the domain) | [`workflows/checkout-saga.workflow.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/workflows/checkout-saga.workflow.ts) |
| Names, signals, updates, input and activity signatures shared by both sides | [`checkout-saga.contract.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/checkout-saga.contract.ts) |
| Activities over the order repository and the two participant ports | [`checkout-saga.activities.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/checkout-saga.activities.ts) |
| Client side, behind `CHECKOUT_SAGA_ENGINE` | [`temporal-checkout-saga.engine.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/temporal-checkout-saga.engine.ts), port in [`checkout-saga-engine.port.ts`](../apps/order-service/src/modules/order/application/ports/checkout-saga-engine.port.ts) |
| Worker supervisor and its shutdown step | [`checkout-saga.worker.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/checkout-saga.worker.ts) |
| Recorded histories the replay spec checks every change against | [`replay-histories/`](../apps/order-service/src/modules/order/infrastructure/temporal/replay-histories), [`checkout-saga.replay.spec.ts`](../apps/order-service/src/modules/order/infrastructure/temporal/checkout-saga.replay.spec.ts) |

## Shared / messaging

The outbox, relay, BullMQ queue, inbox and dead-letter replay are the package [`packages/messaging`](../packages/messaging/src). What each service adds is its route table, which says which queue an event goes to: the api's in [`apps/api/src/shared/messaging/event-routes.ts`](../apps/api/src/shared/messaging/event-routes.ts) (which also holds the consumed queue, `api-events`, with the handlers beside it), the payment-service's in [`apps/payment-service/src/messaging/event-routes.ts`](../apps/payment-service/src/messaging/event-routes.ts), and the order-service's in [`apps/order-service/src/shared/messaging/order-events.routes.ts`](../apps/order-service/src/shared/messaging/order-events.routes.ts) (which also holds the consumed queue, `order-events`, with [`order-events.handlers.ts`](../apps/order-service/src/shared/messaging/order-events.handlers.ts) beside it). The `order-events` queue and the `payment.authorized` event, which cross a process boundary, are in [`packages/internal-contracts/src/queues`](../packages/internal-contracts/src/queues) and [`events`](../packages/internal-contracts/src/events). The api's `shared/messaging` is one of the two composition roots allowed to import across contexts ([`README.md#layering`](../README.md#layering)).

## Schema and migrations

Each Postgres-backed service owns its own schema and migration set against its own Postgres. The id-service has none; its etcd keyspace is defined in [`apps/id-service/src/lease/etcd-lease-keyspace.ts`](../apps/id-service/src/lease/etcd-lease-keyspace.ts):

| Service | Schema barrel | Migrations |
| --- | --- | --- |
| api | [`apps/api/src/shared/infrastructure/database/schema/index.ts`](../apps/api/src/shared/infrastructure/database/schema/index.ts) | [`apps/api/src/shared/infrastructure/database/migrations/`](../apps/api/src/shared/infrastructure/database/migrations/) |
| user-service | [`apps/user-service/src/database/schema.ts`](../apps/user-service/src/database/schema.ts) | [`apps/user-service/src/database/migrations/`](../apps/user-service/src/database/migrations/) |
| inventory-service | [`apps/inventory-service/src/database/schema.ts`](../apps/inventory-service/src/database/schema.ts) | [`apps/inventory-service/src/database/migrations/`](../apps/inventory-service/src/database/migrations/) |
| payment-service | [`apps/payment-service/src/database/schema.ts`](../apps/payment-service/src/database/schema.ts) | [`apps/payment-service/src/database/migrations/`](../apps/payment-service/src/database/migrations/) |
| order-service | [`apps/order-service/src/database/schema.ts`](../apps/order-service/src/database/schema.ts) | [`apps/order-service/src/database/migrations/`](../apps/order-service/src/database/migrations/) |

The outbox and inbox tables come from `@jcool/messaging/schema`, which the payment-service's barrel takes the outbox half of. The api's `schema/index.ts` holds no order, stock or payment table. Migrations are Drizzle-generated (`pnpm db:generate`); the current set is whatever is committed under each `migrations/` directory — list it directly rather than trusting a count here.

## Env schema and config

| Service | Validation + factory |
| --- | --- |
| api | [`apps/api/src/shared/config/env.validation.ts`](../apps/api/src/shared/config/env.validation.ts), [`configuration.ts`](../apps/api/src/shared/config/configuration.ts) |
| id-service | [`apps/id-service/src/config/env.validation.ts`](../apps/id-service/src/config/env.validation.ts), [`configuration.ts`](../apps/id-service/src/config/configuration.ts) |
| user-service | [`apps/user-service/src/config/env.validation.ts`](../apps/user-service/src/config/env.validation.ts), [`configuration.ts`](../apps/user-service/src/config/configuration.ts) |
| inventory-service | [`apps/inventory-service/src/config/env.validation.ts`](../apps/inventory-service/src/config/env.validation.ts), [`configuration.ts`](../apps/inventory-service/src/config/configuration.ts) |
| payment-service | [`apps/payment-service/src/config/env.validation.ts`](../apps/payment-service/src/config/env.validation.ts), [`configuration.ts`](../apps/payment-service/src/config/configuration.ts) |
| order-service | [`apps/order-service/src/config/env.validation.ts`](../apps/order-service/src/config/env.validation.ts), [`configuration.ts`](../apps/order-service/src/config/configuration.ts), and the saga's own settings in [`checkout-saga.env.ts`](../apps/order-service/src/config/checkout-saga.env.ts) and [`checkout-saga.config.ts`](../apps/order-service/src/config/checkout-saga.config.ts) |

Every service composes its env schema from shared fragments in [`packages/platform/src/config`](../packages/platform/src/config) (parsers and strict decorators every app's validator builds on). The commented variable references are [`.env.example`](../.env.example) for the api, [`apps/user-service/.env.example`](../apps/user-service/.env.example) for the user-service, [`apps/inventory-service/.env.example`](../apps/inventory-service/.env.example) for the inventory-service [`apps/payment-service/.env.example`](../apps/payment-service/.env.example) for the payment-service and [`apps/order-service/.env.example`](../apps/order-service/.env.example) for the order-service; see [`README.md#configuration`](../README.md#configuration) for which ones have no default.

## Test tiers

| Tier | Location |
| --- | --- |
| Unit | co-located `*.spec.ts` next to the code it tests, in every app and package |
| Integration (e2e) | `apps/*/test/integration/*.e2e-spec.ts`; setup/harness in `apps/*/test/setup` (e.g. [`apps/api/test/setup/global-setup.ts`](../apps/api/test/setup/global-setup.ts), [`apps/api/test/setup/test-app.factory.ts`](../apps/api/test/setup/test-app.factory.ts); the order-service's suites run against stubs of the services it calls, [`inventory-service-stub.ts`](../apps/order-service/test/setup/inventory-service-stub.ts), [`payment-service-stub.ts`](../apps/order-service/test/setup/payment-service-stub.ts), [`api-internal-stub.ts`](../apps/order-service/test/setup/api-internal-stub.ts) and [`user-service-stub.ts`](../apps/order-service/test/setup/user-service-stub.ts), and a real Temporal server from [`temporal-server.ts`](../apps/order-service/test/setup/temporal-server.ts)) |
| Contract cases | [`packages/internal-contracts/src/testing.ts`](../packages/internal-contracts/src/testing.ts): the case tables and HTTP drivers of the internal APIs, run against the real services and the stubs alike |
| System | `*.system-spec.ts` under `apps/gateway/test/`, `apps/id-service/test/system/` and `apps/order-service/test/system/` — real images on a Docker network, run by `pnpm turbo run test:system --concurrency=1`; the order-service's alone, with a fake Stripe and fault injection, by `pnpm --filter @jcool/order-service run test:system` ([RUNBOOK → Run the system test](../RUNBOOK.md#run-the-system-test)). Local only |
| Load/performance | [`test/load/`](../test/load) (k6 mixes with Prometheus as the authority) and [`k6/`](../k6) |

Discover the current suite rather than trusting a count: `find apps -name '*.e2e-spec.ts'` for integration specs, `find apps -name '*.system-spec.ts'` for system specs. Tier boundaries and coverage-floor rationale are in [`README.md#testing`](../README.md#testing).

## Infra as code

| Concern | Path |
| --- | --- |
| Prometheus alert rules + `promtool` tests | [`infra/prometheus/rules`](../infra/prometheus/rules), [`infra/prometheus/tests`](../infra/prometheus/tests) |
| Grafana dashboards/datasources | [`infra/grafana/provisioning`](../infra/grafana/provisioning) |
| Loki | [`infra/loki/config.yaml`](../infra/loki/config.yaml) |
| OTel Collector | [`infra/otel-collector/config.yaml`](../infra/otel-collector/config.yaml) |
| Temporal server image, bootstrap and server config (deployed by hand, outside CD) | [`infra/temporal`](../infra/temporal) |
| Railway images that bake the config above (Prometheus, Grafana, Loki; Prometheus is deployed by hand, outside CD) and run Elasticsearch and the id-service's etcd | `infra/*/Dockerfile`, e.g. [`infra/etcd/Dockerfile`](../infra/etcd/Dockerfile), [`infra/elasticsearch/Dockerfile`](../infra/elasticsearch/Dockerfile) |

## Scripts

| Where | What lives there |
| --- | --- |
| [`scripts/`](../scripts) | Repo tooling: the CI check on hand-flipped Railway variables, CD's rollout wait, perf-run capture, and the OpenAPI and doc tooling under `scripts/openapi` and `scripts/tooling` |
| [`apps/api/scripts/`](../apps/api/scripts) | The perf seed behind the load tests (`db:seed:perf`) and a trace-propagation harness |
| [`apps/user-service/scripts/`](../apps/user-service/scripts) | Perf-user and bulk user seeds, the epoch prewarm, DB metrics capture; they mint on the node reserved for scripts, under one lock |

## Docs diagrams

[`docs/diagrams/`](./diagrams) holds the SVG pairs (light and dark) the README and `system-architecture.md` embed. The topology and the checkout sequence are Mermaid blocks in the README instead, so they change with the text. The compiler named in [`docs/README.md`](./README.md) is not in the repository: a remaining SVG changes by editing the file, and one that no document embeds any more can be deleted.

## CI/CD and deploy config

CI/CD workflows: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/cd.yml`](../.github/workflows/cd.yml), [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml). Railway service topology: [`.railway/railway.ts`](../.railway/railway.ts). Gateway routing: see below. Details and rationale that the YAML/config can't state are in [`deployment-guide.md`](./deployment-guide.md).

## Gateway

[`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) is the routing config (public site, which sends `/auth` to the user-service, `/admin/inventory*` to the inventory-service, `/webhooks/payment` to the payment-service and `/orders*` and `/admin/orders*` to the order-service, holds the checkout freeze, and fronts the private id-service load balancer); [`apps/gateway/entrypoint.sh`](../apps/gateway/entrypoint.sh) is its container entrypoint.

## Packages

| Package | Role | Owner |
| --- | --- | --- |
| `@jcool/kernel` | Framework-free DDD building blocks | [`packages/kernel/package.json`](../packages/kernel/package.json) |
| `@jcool/id-codec` | Snowflake id layout | [`packages/id-codec/package.json`](../packages/id-codec/package.json) |
| `@jcool/id-generator` | Monotonic id generator, node lease | [`packages/id-generator/package.json`](../packages/id-generator/package.json) |
| `@jcool/auth-verifier` | Access-token verification (every service); `/session-state`: the Redis readers and the user-service client behind an epoch miss | [`packages/auth-verifier/package.json`](../packages/auth-verifier/package.json) |
| `@jcool/internal-contracts` | Paths, bodies and outcome tables of the internal APIs, the `order-events` queue contract and the `payment.authorized` event, shared by both ends; `/testing`: the contract cases | [`packages/internal-contracts/package.json`](../packages/internal-contracts/package.json) |
| `@jcool/messaging` | Outbox, relay, BullMQ queues, inbox and dead-letter replay, parameterised by each service's route table; `/outbox-port`: the pure port domain code imports; `/schema`: the outbox and inbox tables | [`packages/messaging/package.json`](../packages/messaging/package.json) |
| `@jcool/metrics-port` | Metrics seam for domain/application code | [`packages/metrics-port/package.json`](../packages/metrics-port/package.json) |
| `@jcool/platform` | Nest infrastructure glue, one subpath export per concern (config, db, redis, observability, metrics, error tracking, health, throttler, rbac, mail, resilience, retention, identity, interface, internal-api) | [`packages/platform/package.json`](../packages/platform/package.json) |
| `@jcool/testing` | Test doubles, dev-only | [`packages/testing/package.json`](../packages/testing/package.json) |
| `apps/id-service` | 63-bit id minting service, under a leased node id | [`apps/id-service/README.md`](../apps/id-service/README.md) |
| `apps/user-service` | Auth/user service | [`apps/user-service/README.md`](../apps/user-service/README.md) |
| `apps/inventory-service` | Stock levels and the checkout's TCC holds | [`apps/inventory-service/README.md`](../apps/inventory-service/README.md) |
| `apps/payment-service` | Payments, Stripe, the webhook and `payment.authorized` | [`apps/payment-service/README.md`](../apps/payment-service/README.md) |
| `apps/order-service` | Orders, checkout idempotency, the checkout saga's Temporal worker and the `order-events` consumer | [`apps/order-service/README.md`](../apps/order-service/README.md) |

## Discovery commands

Use these instead of a hand-maintained inventory:

- Workspace packages: read [`pnpm-workspace.yaml`](../pnpm-workspace.yaml), or `pnpm -r list --depth -1`.
- HTTP routes: `/docs` (Swagger UI) on a running instance when `SWAGGER_ENABLED` is on.
- e2e specs: `find apps -name '*.e2e-spec.ts'`.
- System specs: `find apps -name '*.system-spec.ts'`.
- Unit specs: `find apps packages -name '*.spec.ts'`.
- Tables per service: the schema barrel in the table above.
