# Deployment guide

Where each environment runs, what owns each deploy target's config, and the rationale behind the deploy pipeline that neither the YAML nor the IaC states outright. Operator procedures live in [`RUNBOOK.md`](../RUNBOOK.md); this page only points to them.

## Environments

| Environment | What runs | Start |
| --- | --- | --- |
| Local dev | Compose infrastructure only (Postgres, Redis, Elasticsearch, Mailpit, MinIO) plus the api on the host | [`README.md#quick-start`](../README.md#quick-start) |
| Full stack, in Compose | Every service containerized, reached through the gateway; the user-service is opt-in via a Compose profile | [`README.md#quick-start`](../README.md#quick-start) |
| Railway (production) | The service topology below, deployed by `cd.yml` | this document |

## Deploy targets and what owns their config

| Target | Owning config |
| --- | --- |
| Railway service topology — build, env, deploy settings for every service | [`.railway/railway.ts`](../.railway/railway.ts) |
| api image | [`Dockerfile`](../Dockerfile) |
| id-service image | [`apps/id-service/Dockerfile`](../apps/id-service/Dockerfile) |
| user-service image | [`apps/user-service/Dockerfile`](../apps/user-service/Dockerfile) |
| gateway image | [`apps/gateway/Dockerfile`](../apps/gateway/Dockerfile) |
| gateway routing — public site plus the private id-service load balancer | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile) |
| Production deploy pipeline | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) |
| Gate CD deploys from | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Local / full-stack composition | [`docker-compose.yml`](../docker-compose.yml) |

## Why the pipeline is shaped this way

[`README.md#operations`](../README.md#operations) explains why CD chains off CI and pins the verified SHA, why migrations run as a release command, and how the api drains on `SIGTERM`. The rest of the reasoning is commented where it is enforced:

| Question | Answered in |
| --- | --- |
| Why this deploy order, and why the gateway follows the api | [`.github/workflows/cd.yml`](../.github/workflows/cd.yml), above the deploy steps |
| Why `railway up --ci` returning is not the success gate | [`scripts/railway-wait-for-rollout.sh`](../scripts/railway-wait-for-rollout.sh) |
| Why hand-flipped variables must stay declared and `preserve()`d, and which ones | [`scripts/check-railway-flip-vars.mjs`](../scripts/check-railway-flip-vars.mjs), run by `ci.yml` |
| How the gateway's drain window relates to Railway's `drainingSeconds` | [`apps/gateway/Caddyfile`](../apps/gateway/Caddyfile), global options |

Two facts none of those files state:

- **id-service deploys first** because the api mints every row id through it, and a dependency goes live before its dependents ([`README.md#known-limits`](../README.md#known-limits)).
- **Every Node service migrates its own database as a Railway `preDeployCommand`**, not just the api the README walks through; see each service's `deploy` block in [`.railway/railway.ts`](../.railway/railway.ts).

## Production-required settings

Settings the process refuses to boot without in production stay owned by [`README.md#configuration`](../README.md#configuration) (for example `TRUST_PROXY`), with the per-service auth variables in [`apps/user-service/README.md`](../apps/user-service/README.md).

## Runbook

Every manual operation is in [`RUNBOOK.md`](../RUNBOOK.md), indexed by its own contents list. The ones a deploy itself can lead to:

- a boot refused after a key or id-layout change → [If a boot is refused](../RUNBOOK.md#if-a-boot-is-refused)
- a variable to add, remove or flip on a Railway service → [Change Railway service config](../RUNBOOK.md#change-railway-service-config)
- a migration that must not wait for the next deploy → [Apply migrations out of band](../RUNBOOK.md#apply-migrations-out-of-band)
- moving the public domain onto the gateway → [Put the gateway in front of the api](../RUNBOOK.md#put-the-gateway-in-front-of-the-api)
