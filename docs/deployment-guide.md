# Deployment guide

Where each environment runs, what owns each deploy target's config, and the rationale behind the deploy pipeline that neither the YAML nor the IaC states outright. Operator procedures live in [`RUNBOOK.md`](../RUNBOOK.md); this page only points to them.

## Environments

| Environment | What runs | Start |
| --- | --- | --- |
| Local dev | Compose infrastructure (Postgres ×3, Redis, Elasticsearch, Mailpit, MinIO, Temporal with its own Postgres, etcd) and the gateway, in front of the api, the user-service, the inventory-service and the id-service on the host under `pnpm dev` | [`README.md#quick-start`](../README.md#quick-start) |
| Full stack, in Compose | Every service containerized, reached through the gateway; the user-service is opt-in via a Compose profile, the inventory-service is not | [`README.md#quick-start`](../README.md#quick-start) |
| Railway (production) | The service topology below, deployed by `cd.yml` | this document |

## Deploy targets and what owns their config

| Target | Owning config |
| --- | --- |
| Railway service topology — build, env, deploy settings for every service | [`.railway/railway.ts`](../.railway/railway.ts) |
| api image | [`Dockerfile`](../Dockerfile) |
| id-service image | [`apps/id-service/Dockerfile`](../apps/id-service/Dockerfile) |
| user-service image | [`apps/user-service/Dockerfile`](../apps/user-service/Dockerfile) |
| inventory-service image | [`apps/inventory-service/Dockerfile`](../apps/inventory-service/Dockerfile) |
| gateway image | [`apps/gateway/Dockerfile`](../apps/gateway/Dockerfile) |
| Temporal server image and its bootstrap (databases, schema, namespace, search attributes) | [`infra/temporal/Dockerfile`](../infra/temporal/Dockerfile), [`infra/temporal/entrypoint.sh`](../infra/temporal/entrypoint.sh) |
| gateway routing — public site (`/auth` to the user-service, `/admin/inventory*` to the inventory-service, the rest to the api) plus the private id-service load balancer | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) |
| Prometheus scrape jobs (`jcool-api`, `jcool-inventory`) and their Railway targets | [`infra/prometheus/prometheus.railway.yml`](../infra/prometheus/prometheus.railway.yml), [`infra/prometheus/railway-entrypoint.sh`](../infra/prometheus/railway-entrypoint.sh) |
| Production deploy pipeline | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) |
| Gate CD deploys from | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Local / full-stack composition | [`docker-compose.yml`](../docker-compose.yml) |

## Why the pipeline is shaped this way

[`README.md#operations`](../README.md#operations) explains why CD chains off CI and pins the verified SHA, why migrations run as a release command, and how the api drains on `SIGTERM`. The rest of the reasoning is commented where it is enforced:

| Question | Answered in |
| --- | --- |
| Why this deploy order (id-service → user-service → inventory-service → api → gateway), and why the gateway goes last | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml), above the deploy steps |
| Why `railway up --ci` returning is not the success gate | [`scripts/railway-wait-for-rollout.sh`](../scripts/railway-wait-for-rollout.sh) |
| Why hand-flipped variables must stay declared and `preserve()`d, and which ones | [`scripts/check-railway-flip-vars.mjs`](../scripts/check-railway-flip-vars.mjs), run by `ci.yml` |
| How the gateway's drain window relates to Railway's `drainingSeconds` | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile), global options |
| Why the api's `drainingSeconds` is 30, as a sum of its shutdown steps | [`.railway/railway.ts`](../.railway/railway.ts), next to `SHUTDOWN_GRACE_PERIOD_MS` |

Four facts none of those files state:

- **id-service deploys first** because every service mints its row ids through it, and a dependency goes live before its dependents ([`README.md#known-limits`](../README.md#known-limits)).
- **Every Node service runs a Railway `preDeployCommand`**, not just the api the README walks through: the api, the user-service and the inventory-service migrate their own databases, and the id-service lifts its etcd floors if the keyspace is empty ([`lift-floors-cli.ts`](../apps/id-service/src/lease/lift-floors-cli.ts)); see each service's `deploy` block in [`.railway/railway.ts`](../.railway/railway.ts).
- **The inventory-service seeds after it migrates**, in the same `preDeployCommand` and the same process ([`pre-deploy-cli.ts`](../apps/inventory-service/src/database/pre-deploy-cli.ts); Railway runs the command without a shell, so it cannot chain two with `&&`): every variant the public catalog lists gets a level of 1e9 if it has none, and an existing level is never touched. The seed runs best effort, so an unlistable catalog skips the seed rather than failing the rollout; it reads the catalog from the api through the gateway (`CATALOG_PUBLIC_URL`), so a new variant gets stock on the next inventory-service deploy or a hand-run seed ([RUNBOOK → Cut stock over to the inventory-service](../RUNBOOK.md#cut-stock-over-to-the-inventory-service)).
- **`temporal` is deployed by hand**, outside `cd.yml`, like etcd and Elasticsearch: it has no repo source. CD does not wait on it, and it does not need to, since the api boots and stays ready without Temporal ([RUNBOOK → Operate Temporal](../RUNBOOK.md#operate-temporal)).

## Production-required settings

Settings the process refuses to boot without in production stay owned by [`README.md#configuration`](../README.md#configuration) (for example `TRUST_PROXY`), with the per-service auth variables in [`apps/user-service/README.md`](../apps/user-service/README.md) and the stock ones in [`apps/inventory-service/README.md`](../apps/inventory-service/README.md#configuration). Two services' settings meet in one rule no validator can check: the inventory-service's `INVENTORY_TRY_LOCK_TIMEOUT_MS` stays below the api's `CHECKOUT_TRY_TIMEOUT_MS` ([RUNBOOK → Cross-service settings](../RUNBOOK.md#cross-service-settings)).

## Runbook

Every manual operation is in [`RUNBOOK.md`](../RUNBOOK.md), indexed by its own contents list. The ones a deploy itself can lead to:

- a boot refused after a key or id-layout change → [If a boot is refused](../RUNBOOK.md#if-a-boot-is-refused)
- a variable to add, remove or flip on a Railway service → [Change Railway service config](../RUNBOOK.md#change-railway-service-config)
- a migration that must not wait for the next deploy → [Apply migrations out of band](../RUNBOOK.md#apply-migrations-out-of-band)
- moving the public domain onto the gateway → [Put the gateway in front of the api](../RUNBOOK.md#put-the-gateway-in-front-of-the-api)
- the api's worker cannot reach Temporal → [Temporal down](../RUNBOOK.md#temporal-down)
- moving stock onto the inventory-service, or back → [Cut stock over to the inventory-service](../RUNBOOK.md#cut-stock-over-to-the-inventory-service)
- a caller answered `401` or `403` by an internal API → [Per-caller internal tokens](../RUNBOOK.md#per-caller-internal-tokens)
