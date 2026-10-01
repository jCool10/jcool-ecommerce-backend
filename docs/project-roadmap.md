# Roadmap

Intended direction that has not shipped, not a description of current behavior. For what is live today, read [`../README.md`](../README.md) and [`../RUNBOOK.md`](../RUNBOOK.md). Conditional follow-ups ("if X becomes a bottleneck, do Y") are not roadmap items — they live in [`./system-architecture.md#decision-ledger`](./system-architecture.md#decision-ledger).

## Cut the public domain over to the gateway

The api, user-service and id-service already run split and the Caddy gateway is deployed, but the public domain still points at the api directly rather than through the gateway — see the architecture note in [`README.md#architecture`](../README.md#architecture) ("once the public domain moves onto the gateway") and the cutover procedure at [`RUNBOOK.md#put-the-gateway-in-front-of-the-api`](../RUNBOOK.md#put-the-gateway-in-front-of-the-api). Until that flip, the IP-keyed throttle tiers count connections rather than clients, a gap [`README.md#known-limits`](../README.md#known-limits) already states.

## Shard the user database

The user-service's single Postgres instance is the deliberate starting point, not the end state. Ids carry no routing field, so a split needs a lookup or directory from a user to its shard, not a bit read from the id. That trade is recorded in [`system-architecture.md`](./system-architecture.md#63-bit-snowflake-layout-45-ts_ms--8-node--10-seq).
