# Roadmap

Intended direction that has not shipped, not a description of current behavior. For what is live today, read [`../README.md`](../README.md) and [`../RUNBOOK.md`](../RUNBOOK.md).

There is no committed work beyond what is live. The extraction of identity, ids, stock, payment and checkout into services of their own is done, and the public domain's move onto the gateway is an operator step with its own procedure ([`RUNBOOK.md#put-the-gateway-in-front-of-the-api`](../RUNBOOK.md#put-the-gateway-in-front-of-the-api)), not a pending feature.

What may change later is conditional, so it is not a roadmap item: each follow-up is a "revisit when" trigger on the decision it would change, in [`system-architecture.md#decision-ledger`](./system-architecture.md#decision-ledger). The checkout saga's triggers (dropping manual capture, a second consumer of one event type, the cost of self-hosting Temporal) are at the end of [its record](./system-architecture.md#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment); the user database's shard split is on the [id layout](./system-architecture.md#63-bit-snowflake-layout-45-ts_ms--8-node--10-seq).
