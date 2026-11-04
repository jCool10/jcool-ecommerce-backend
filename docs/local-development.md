# Local development

Running, testing and scripting the system on one machine. The setup commands are the README's [Quick start](../README.md#quick-start); this page covers what they leave out. Operating the deployed system is the [RUNBOOK](../RUNBOOK.md).

## Prerequisites

Node ≥ 22.9, pnpm (any recent install switches itself to the version pinned in `packageManager`), Docker (for infrastructure and the integration tests).

## Setup notes

- The env templates boot as-is against the Compose stack, once the user-service's `.env` has a signing key (`JWT_ES256_PRIVATE_KEYS`; the openssl one-liner is in its template). The api runs from `apps/api`, so `pnpm dev:link-env` links the root `.env` there.
- The ports in the Compose commands are the host-mapped ones. The gateway fronts the host: its load balancer on 127.0.0.1:4000, where the apps mint ids, dials the id-service on 3003, and 8080 reaches the api and the four other services as in production.
- Every service but the api migrates from its own build, so `pnpm build` comes before the migrations. A fresh etcd has no floors, and the id-service claims no node until `lease:lift-floors` has written them.
- The inventory-service's stock seed walks the public catalog through the gateway (`CATALOG_PUBLIC_URL`), so it cannot run before `pnpm dev` serves the api.
- `minio-init` is a one-shot that creates `STORAGE_BUCKET` and exits; the app waits on it, so a fresh `docker compose up` has a bucket before the first upload.
- Elasticsearch is only needed with `SEARCH_ENABLED=true`, and on a Linux host it wants `sudo sysctl -w vm.max_map_count=262144` first (Docker Desktop already sets it).
- Skipping Mailpit does **not** fall back to the log sink — `.env.example` ships `SMTP_URL` uncommented, so sends would fail against a dead relay; comment it out to use the log sink.
- Without Temporal the api still boots and serves everything but checkout and cancel, which the order-service answers `503`; its `/health/ready` reports `503` naming `temporal` and its saga worker logs `checkout saga worker unavailable; retrying with backoff` until the server answers.

## Ports

- API → <http://localhost:3000> · OpenAPI → <http://localhost:3000/docs> · user-service → <http://localhost:3002> · id-service → <http://localhost:3003> · inventory-service → <http://localhost:3004> · payment-service → <http://localhost:3005> · order-service → <http://localhost:3006> · gateway → <http://localhost:8080>
- Mail inbox (Mailpit) → <http://localhost:8025> · MinIO console → <http://localhost:9001>
- Postgres → `localhost:5433` (user-service: `localhost:5434`, inventory-service: `localhost:5435`, payment-service: `localhost:5436`, order-service: `localhost:5437`) · Redis → `localhost:6380` · Elasticsearch → `localhost:9200` · id-service load balancer → `localhost:4000` · Temporal → `localhost:7233` (UI on `localhost:8233` with `--profile observability`)

## How `pnpm dev` works

`pnpm dev` is `turbo watch dev`. It builds the packages, then runs `dev` in the api (`nest start --watch`), the user-service, the inventory-service, the payment-service, the order-service and the id-service. A change under `packages/` rebuilds that package and every package that depends on it, then restarts the apps that use them. A change in the api's `src/` is left to Nest's own incremental reload, because [`apps/api/turbo.json`](../apps/api/turbo.json) limits the inputs of the api's `dev` task to its config files (`futureFlags.watchUsingTaskInputs` in the root `turbo.json`). The other services have no watcher of their own, so turbo rebuilds them with `tsc` and restarts them; the id-service releases its node on each restart and claims another. To run one app with the packages it uses: `pnpm turbo watch dev --filter=@jcool/api`. With a filter, turbo 2.11.6 still starts `dev` in the other apps that depend on a package you change; without `watchUsingTaskInputs` it honours the filter, but every save in the api then restarts it twice. Keep `SHUTDOWN_GRACE_PERIOD_MS` at `0` locally, since each restart and Ctrl+C waits it out. Turbo runs tasks in strict env mode, so a variable set on the command line (`PORT=3005 pnpm dev`) never reaches the app; put overrides in the `.env` files. Don't run a service's container alongside `pnpm dev`: each binds the same port as its host twin (3002, 3004, 3005, 3006). `pnpm dev:gateway` stops the id-service containers and recreates the gateway with every upstream on `host.docker.internal`, so the gateway answers `502` while `pnpm dev` is down; `docker compose up -d id-service gateway` puts it back in front of the containers.

## How the workspace builds

pnpm workspace, tasks run through Turborepo. Packages compile to CommonJS `dist/` with `tsc` and are consumed the way production consumes them, tests included. Every Turborepo task depends on `^build`, so the packages are built first, in dependency order: `kernel`, `metrics-port` and `internal-contracts`, then `id-codec`, then `id-generator`, then `platform`, then `auth-verifier` and `messaging`, then the apps. `@jcool/testing` is never built. Scripts forwarded straight to the api (`start:dev`, `test:watch`, `db:*`, the CLIs) skip Turborepo and read the last build, so run `pnpm build` after changing a package before using them. Nest, nestjs-pino, prom-client, ioredis and drizzle-orm are among the peer dependencies of `platform`. The lockfile resolves each to a single install shared by the app and the package, and `apps/api/src/platform-peer-dependencies.spec.ts` fails once the two manifests drift apart.

## Full stack in Compose

Full stack in-network, behind the gateway as on Railway: `docker compose up -d --build`, then <http://localhost:8080>. The app container publishes no port there; the inventory-service, the payment-service, the order-service, their Postgres databases and their one-shot migrators come up with it. The payment-service runs there with `NODE_ENV=production`, so it refuses to boot without a `sk_test_` `STRIPE_SECRET_KEY` and a `STRIPE_SUCCESS_URL` in the root `.env`, which Compose passes through; `/pay` answers `502` until it is up. `pnpm db:seed` from the host then seeds the api's catalog and, through the gateway, the stock (it reads `apps/inventory-service/.env`). Tear down including volumes: `docker compose --profile '*' down -v` (without a profile, `down` leaves the profile-gated services, the user-service's Postgres and its volume included). The user-service is opt-in, since it needs `apps/user-service/.env`: `docker compose --profile user-service up -d --build user-service` serves it on <http://127.0.0.1:3002>, with its Postgres on 127.0.0.1:5434. Redis runs with AOF on, which the api and the user-service both require.

## Local observability stack

The local stack is profile-gated and binds to loopback only:

```bash
docker compose --profile observability up -d   # Collector + Prometheus + Grafana + Jaeger
```

Prometheus <http://localhost:9090> · Grafana <http://localhost:3001> · Jaeger <http://localhost:16686>. Scraping the app locally needs `infra/prometheus/secrets/metrics-token` to match `METRICS_TOKEN` (gitignored; only the `.example` is committed), and `pnpm alerts:*` needs `promtool` on `PATH` — it is not an npm dependency, CI installs it from the pinned Prometheus release. What is wired and what runs on Railway: [engineering-highlights.md → Observability](./engineering-highlights.md#observability).

## Tests

```bash
pnpm test           # unit tests in every workspace; hermetic, no Docker
pnpm test:cov       # same, with the unit coverage floors
pnpm test:e2e       # integration suites in every workspace; requires Docker
pnpm turbo run test:e2e:cov --filter=@jcool/order-service   # unit + e2e of one app, coverage merged and floored
```

- **Unit** (`src/**/*.spec.ts`) — fast and hermetic, with a deterministic `uuid` double so generated ids are stable within a run.
- **Integration** (`apps/*/test/integration/*.e2e-spec.ts`) — the app wired to real infrastructure through Testcontainers; how the containers are shared is in [engineering-highlights.md → Testing on real infrastructure](./engineering-highlights.md#testing-on-real-infrastructure).

`E2E_WORKERS` (default **4**) sets how many workers the integration tier runs across; `E2E_WORKERS=1` serialises it. Each worker gets its own Postgres database and its own Redis logical database, so the number is bounded by Redis's 16 indices and by the databases `globalSetup` pre-creates.

`pnpm turbo run test:system --concurrency=1` adds a third tier, run locally; CI runs only the gateway's fixture-only specs from it. It builds the real images of the `id-service`, the `gateway` and the order-service's whole checkout and runs them on a Docker network. The order-service's alone runs with `pnpm --filter @jcool/order-service run test:system`; it needs Docker and several GB of RAM. Run time: about 8 minutes with the images built (465–510s over three runs on an Apple M4, Docker with 10 CPUs and 8 GB), about 13 minutes when it builds them. How to run it and read a failure: [RUNBOOK → Run the system test](../RUNBOOK.md#run-the-system-test).

Vitest runs through **SWC**, not its default esbuild, because esbuild does not emit `emitDecoratorMetadata` — which NestJS DI needs, so `Test.createTestingModule()` would fail at the app layer. SWC is transpile-only, which is why `tsc --noEmit` is a separate gate.

Coverage floors, which tier a test belongs in and how a test deletion is proven: [code-standards.md → Tests](./code-standards.md#tests).

## Scripts

Run from the repo root with `pnpm <script>`. `build`, `typecheck`, `lint` / `lint:check`, `arch:check`, `test`, `test:cov` and `test:e2e` go through Turborepo, and `dev` through `turbo watch`; the other app scripts (`test:watch` / `test:debug` included) forward to `@jcool/api`, and `alerts:*` / `load:*` run at the root. Turborepo scripts run in every workspace project, so arguments go to one project at a time (`pnpm turbo run test --filter=@jcool/api -- src/modules/cart`, paths relative to that project); the others take them directly (`pnpm queue:replay-dlq:order --queue order-events --apply`), since pnpm forwards a literal `--` to the command.

| Script | Purpose |
| --- | --- |
| `dev` | The api, the user-service, the inventory-service, the payment-service, the order-service and the id-service on the host; a changed package is rebuilt and the apps that use it restart |
| `dev:link-env` | Symlink the root `.env` into `apps/api` |
| `start` · `start:dev` · `start:debug` | The api alone, on the last package build: once · in watch mode · in watch mode with the inspector |
| `start:prod` · `build` | Compiled run (`node --env-file-if-exists=.env --import ./dist/instrumentation.js dist/main`) · Nest SWC build |
| `typecheck` · `lint` / `lint:check` · `format` | `tsc --noEmit` · ESLint with / without `--fix` · Prettier |
| `arch:check` | dependency-cruiser boundary rules |
| `railway:check-flip-vars` | Fail if a hand-flipped Railway switch (`TRUST_PROXY`, the gateway's `AUTH_*` and `TRUSTED_PROXY_CIDRS`) is no longer declared and preserved in `.railway/railway.ts` |
| `alerts:check` · `alerts:test` | Prometheus rules parse · and fire (and clear) on the timelines they claim to |
| `test` · `test:cov` · `test:e2e` | Unit · unit with the coverage floor · integration (needs Docker) |
| `pnpm turbo run test:e2e:cov --filter=<app>` | Unit and integration of one app under coverage, merged into `coverage/merged` and checked against the merged floors (needs Docker) |
| `pnpm turbo run test:system` | The system tests of the order-service, the id-service and the gateway: real images on a Docker network, local only |
| `test:watch` · `test:debug` | The api's unit tests in Vitest watch mode · under the inspector, one file at a time |
| `db:generate` · `db:migrate` · `db:migrate:prod` · `db:studio` | The api's Drizzle migration workflow (`:prod` runs the compiled CLI — the image's release command). Each other service has its own `db:migrate` under `pnpm --filter` |
| `db:seed` | The api's catalog, then the inventory-service's stock: 1e9 on hand for every listed variant that has no level. The stock half lists the catalog through the gateway, so the api must be serving |
| `search:reindex` | Rebuild the search index from Postgres into a fresh index, then swap the `products` alias onto it, so search never goes empty |
| `queue:replay-dlq` · `queue:replay-dlq:order` | Inspect one queue's dead-letter queue, with the api's CLI (`--queue api-events`) or the order-service's (`--queue order-events`); `--queue` is required, `--apply` to replay (dry run is the default) |
| `storage:verify` | Reconcile bucket against `media_assets` three ways: orphan objects, `ATTACHED` rows whose object is gone, and `product_images` rows whose asset row is gone |
| `load:baseline` · `load:register:*` | k6 mixes |
| `load:cache-stampede` · `load:breakpoint` · `load:sku-contention` | Performance-experiment mixes (`test/load/`): cache stampede arms, open-model breakpoint ramp, single-SKU reservation contention. Each exports `--summary-export` JSON; authoritative numbers come from Prometheus, not k6 timing |
| `load:public-read` | Anonymous read profile for a **deployed** instance (`BASE_URL=…`, `PROFILE=steady` \| `burst`). No Prometheus and no write journey — see [Measured performance](./engineering-highlights.md#measured-performance) for what it can and cannot answer |
| `db:seed:perf-user` · `db:seed:perf` | Perf user in user-service · catalog and that user's cart in the api (resolves the user by logging in to user-service, so seed the user first). Stock comes after, from the cache bump and the inventory-service seed its last log line prints |
| `seed:users:bulk` · `db:metrics:users` | Bulk identity seed · DB benchmark capture, both against the user-service database |

`:prod` twins (`db:migrate:prod`, `queue:replay-dlq:prod`, `queue:replay-dlq:order:prod`, `search:reindex:prod`, `storage:verify:prod`) run the compiled CLI from `dist/`, because `tsx` is a devDependency and is not installed in the image.
