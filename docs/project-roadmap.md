# Roadmap

Intended direction that has not shipped, not a description of current behavior. For what is live today, read [`../README.md`](../README.md) and [`../RUNBOOK.md`](../RUNBOOK.md). Conditional follow-ups ("if X becomes a bottleneck, do Y") are not roadmap items — they live in [`./system-architecture.md#decision-ledger`](./system-architecture.md#decision-ledger).

## Cut the public domain over to the gateway

The api, user-service and id-service already run split and the Caddy gateway is deployed, but the public domain still points at the api directly rather than through the gateway — see the architecture note in [`README.md#architecture`](../README.md#architecture) ("once the public domain moves onto the gateway") and the cutover procedure at [`RUNBOOK.md#put-the-gateway-in-front-of-the-api`](../RUNBOOK.md#put-the-gateway-in-front-of-the-api). Until that flip, the IP-keyed throttle tiers count connections rather than clients, a gap [`README.md#known-limits`](../README.md#known-limits) already states.

## Shard the user database by bucket

Every user-owned row's id already embeds the 12-bit routing bucket a future shard split will read directly — no lookup table required. That intent is recorded next to the constraint that makes it irreversible: [`README.md#data-modelling`](../README.md#data-modelling) ("a future shard split routes from the id alone") and [`RUNBOOK.md#never-rotate-identity_bucket_key`](../RUNBOOK.md#never-rotate-identity_bucket_key) ("the bucket is what a future `users` shard split routes on"). The user-service's single Postgres instance is the deliberate starting point, not the end state.
