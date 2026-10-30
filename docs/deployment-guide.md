# Deployment guide

Where each environment runs, what owns each deploy target's config, and the rationale behind the deploy pipeline that neither the YAML nor the IaC states outright. Operator procedures live in [`RUNBOOK.md`](../RUNBOOK.md); this page only points to them.

## Environments

| Environment | What runs | Start |
| --- | --- | --- |
| Local dev | Compose infrastructure (a Postgres per service, Redis, Elasticsearch, Mailpit, MinIO, Temporal with its own Postgres, etcd) and the gateway, in front of the api, the user-service, the order-service, the inventory-service, the payment-service and the id-service on the host under `pnpm dev` | [`README.md#quick-start`](../README.md#quick-start) |
| Full stack, in Compose | Every service containerized, reached through the gateway; the user-service is opt-in via a Compose profile, the order-service, the inventory-service and the payment-service are not (the order-service and the payment-service run with `NODE_ENV=production`, so the payment-service needs a `sk_test_` key in the root `.env`) | [`README.md#quick-start`](../README.md#quick-start) |
| Railway (production) | The service topology below, deployed by `cd.yml` | this document |

## Deploy targets and what owns their config

| Target | Owning config |
| --- | --- |
| Railway service topology — build, env, deploy settings for every service | [`.railway/railway.ts`](../.railway/railway.ts) |
| api image | [`Dockerfile`](../Dockerfile) |
| id-service image | [`apps/id-service/Dockerfile`](../apps/id-service/Dockerfile) |
| user-service image | [`apps/user-service/Dockerfile`](../apps/user-service/Dockerfile) |
| order-service image, with the workflow bundle its build step writes | [`apps/order-service/Dockerfile`](../apps/order-service/Dockerfile) |
| inventory-service image | [`apps/inventory-service/Dockerfile`](../apps/inventory-service/Dockerfile) |
| payment-service image | [`apps/payment-service/Dockerfile`](../apps/payment-service/Dockerfile) |
| gateway image | [`apps/gateway/Dockerfile`](../apps/gateway/Dockerfile) |
| Temporal server image and its bootstrap (databases, schema, namespace, search attributes) | [`infra/temporal/Dockerfile`](../infra/temporal/Dockerfile), [`infra/temporal/entrypoint.sh`](../infra/temporal/entrypoint.sh) |
| gateway routing — public site (the checkout freeze first, then `/auth` to the user-service, `/orders*` and `/admin/orders*` to the order-service, `/admin/inventory*` to the inventory-service, `/webhooks/payment` to the payment-service, the rest to the api) plus the private id-service load balancer | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) |
| Prometheus scrape jobs (`jcool-api`, `jcool-order`, `jcool-inventory`, `jcool-payment`) and their Railway targets | [`infra/prometheus/prometheus.railway.yml`](../infra/prometheus/prometheus.railway.yml), [`infra/prometheus/railway-entrypoint.sh`](../infra/prometheus/railway-entrypoint.sh) |
| Production deploy pipeline | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) |
| Gate CD deploys from | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Local / full-stack composition | [`docker-compose.yml`](../docker-compose.yml) |

## Why the pipeline is shaped this way

[`README.md#operations`](../README.md#operations) explains why CD chains off CI and pins the verified SHA, why migrations run as a release command, and how the api drains on `SIGTERM`. The rest of the reasoning is commented where it is enforced:

| Question | Answered in |
| --- | --- |
| Why this deploy order, after the plan, the destructive-change review, the apply and the empty-plan check: id-service → user-service → inventory-service → payment-service → order-service → api → gateway, then the smoke of the public URL; and why the gateway goes last | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml), above the deploy steps |
| Why `railway up --ci` returning is not the success gate | [`scripts/railway-wait-for-rollout.sh`](../scripts/railway-wait-for-rollout.sh) |
| Why hand-flipped variables must stay declared and `preserve()`d, and which ones | [`scripts/check-railway-flip-vars.mjs`](../scripts/check-railway-flip-vars.mjs), run by `ci.yml` |
| How the gateway's drain window relates to Railway's `drainingSeconds` | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile), global options |
| Why the api's and the order-service's `drainingSeconds` are 30, as sums of their shutdown steps | [`.railway/railway.ts`](../.railway/railway.ts), in each service's `deploy` block |

Facts none of those files state:

- **id-service deploys first** because every service mints its row ids through it, and a dependency goes live before its dependents ([`README.md#known-limits`](../README.md#known-limits)).
- **Every Node service runs a Railway `preDeployCommand`**, not just the api the README walks through: the api, the user-service, the order-service, the inventory-service and the payment-service migrate their own databases, and the id-service lifts its etcd floors if the keyspace is empty ([`lift-floors-cli.ts`](../apps/id-service/src/lease/lift-floors-cli.ts)); see each service's `deploy` block in [`.railway/railway.ts`](../.railway/railway.ts).
- **The inventory-service seeds after it migrates**, in the same `preDeployCommand` and the same process ([`pre-deploy-cli.ts`](../apps/inventory-service/src/database/pre-deploy-cli.ts); Railway runs the command without a shell, so it cannot chain two with `&&`): every variant the public catalog lists gets a level of 1e9 if it has none, and an existing level is never touched. The seed runs best effort, so an unlistable catalog skips the seed rather than failing the rollout; it reads the catalog from the api through the gateway (`CATALOG_PUBLIC_URL`), so a new variant gets stock on the next inventory-service deploy or a hand-run seed ([RUNBOOK → The inventory-service](../RUNBOOK.md#the-inventory-service)).
- **CD deploys the seven services above and nothing else.** `temporal` and `prometheus` are the two a release can depend on: they are built from [`infra/temporal`](../infra/temporal) and [`infra/prometheus`](../infra/prometheus), declared in `.railway/railway.ts`, and take new code only when someone runs `railway up` for them, like etcd, Elasticsearch, Loki and Grafana. A change under `infra/prometheus/` (rules, scrape jobs) is live only after that manual deploy ([RUNBOOK → Redeploy Prometheus](../RUNBOOK.md#redeploy-prometheus)); Temporal's operation is in [RUNBOOK → Operate Temporal](../RUNBOOK.md#operate-temporal).
- **CD depends on Temporal without deploying it.** The order-service's readiness includes Temporal, so with Temporal down CD stops at the order-service's healthcheck, before the api, and production keeps the code it runs. The api's and the gateway's readiness leave Temporal out, so a freeze or unfreeze still deploys ([RUNBOOK → Temporal down](../RUNBOOK.md#temporal-down)). A failed deploy is fixed forward, never rolled back into the api ([RUNBOOK → Rollback rules](../RUNBOOK.md#rollback-rules)).
- **The order-service reads the cart and the catalog from the api** over the private network (`API_SERVICE_URL`, never the gateway, which answers `/internal/*` with 404), so the api is a synchronous dependency of `POST /orders`; with the api down checkout answers `503` ([RUNBOOK → The order-service](../RUNBOOK.md#the-order-service)).

## Production-required settings

Each service's env validator is the final word on what it refuses to boot without ([`env.validation.ts`](./codebase-summary.md#env-schema-and-config) per service). What `NODE_ENV=production` adds on top of the variables that are required everywhere:

| Service | Refuses to boot in production without | Reference |
| --- | --- | --- |
| api | `TRUST_PROXY` | [`README.md#configuration`](../README.md#configuration) |
| user-service | `TRUST_PROXY`, `APP_PUBLIC_URL` (the default is localhost, which would go out in every mailed link) | [`apps/user-service/README.md`](../apps/user-service/README.md) |
| inventory-service | `TRUST_PROXY` | [`apps/inventory-service/README.md`](../apps/inventory-service/README.md#configuration) |
| payment-service | `STRIPE_SECRET_KEY` and `STRIPE_SUCCESS_URL` | [`apps/payment-service/README.md`](../apps/payment-service/README.md#configuration) |
| order-service | `TRUST_PROXY`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | [`apps/order-service/README.md`](../apps/order-service/README.md#configuration) |
| id-service | nothing beyond its everywhere-required set | [`apps/id-service/README.md`](../apps/id-service/README.md) |

Each caller token is required too: a callee refuses to boot with no `INTERNAL_CALLER_TOKEN_<CALLER>` at all or with two callers sharing a value, and each caller's `*_SERVICE_TOKEN` must equal its callee's ([RUNBOOK → Per-caller internal tokens](../RUNBOOK.md#per-caller-internal-tokens)). Settings of two services meet in rules no validator can check: the inventory-service's `INVENTORY_TRY_LOCK_TIMEOUT_MS` stays below the order-service's `CHECKOUT_TRY_TIMEOUT_MS`, the payment-service's timeouts, session floor and `ORDER_PAID_CONSUMER_ATTEMPTS` line up with the order-service's, and the order-service's shutdown steps fit its `drainingSeconds` ([RUNBOOK → Cross-service settings](../RUNBOOK.md#cross-service-settings)).

## Runbook

Every manual operation is in [`RUNBOOK.md`](../RUNBOOK.md), indexed by its own contents list. The ones a deploy itself can lead to:

- a boot refused after a key or id-layout change → [If a boot is refused](../RUNBOOK.md#if-a-boot-is-refused)
- a variable to add, remove or flip on a Railway service → [Change Railway service config](../RUNBOOK.md#change-railway-service-config)
- a migration that must not wait for the next deploy → [Apply migrations out of band](../RUNBOOK.md#apply-migrations-out-of-band)
- moving the public domain onto the gateway → [Put the gateway in front of the api](../RUNBOOK.md#put-the-gateway-in-front-of-the-api)
- the order-service's worker cannot reach Temporal, or CD stopped at its healthcheck → [Temporal down](../RUNBOOK.md#temporal-down)
- a merge that deletes Railway variables or drops tables, or a deploy that failed → [The contract step](../RUNBOOK.md#the-contract-step), [Rollback rules](../RUNBOOK.md#rollback-rules)
- moving another participant out of a service the way checkout moved → [Cut checkout over to the order-service](../RUNBOOK.md#cut-checkout-over-to-the-order-service), kept as the skeleton
- stopping checkout writes while something changes → [Freeze checkout](../RUNBOOK.md#freeze-checkout)
- a Prometheus rule or scrape change → [Redeploy Prometheus](../RUNBOOK.md#redeploy-prometheus)
- checking a saga change end to end before the merge → [Run the system test](../RUNBOOK.md#run-the-system-test)
- a parked message, by the service that consumes its queue → [Dead-letter queues](../RUNBOOK.md#dead-letter-queues)
- a caller answered `401` or `403` by an internal API → [Per-caller internal tokens](../RUNBOOK.md#per-caller-internal-tokens)
