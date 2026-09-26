# ADR: Keeping the search index consistent with the catalog

Status: accepted, 2026-09-25. Replaces the Meilisearch adapter and its best-effort post-commit sync.

## Context

`/products/search` reads an Elasticsearch index. The index is derived data: Postgres is the only source of truth for the catalog, and the index can always be rebuilt from it. No transaction spans Postgres and the engine, so any design has to answer one question: what brings the index back into line after a write that committed in Postgres but never reached the engine?

The previous design called the engine right after the commit and logged the failure. A crash, a deploy or an engine outage between the two left the index wrong until someone ran a full reindex, and nothing said which documents were stale.

What the design had to hold, in order of weight:

- A committed catalog write always reaches the index, with no manual step while the engine comes back within the retry horizon.
- Deliveries in any order, repeated or late, leave the newest state in the index.
- An archived product never reappears in search.
- A full rebuild never leaves search empty.
- Catalog work never delays order and payment work.

## Options considered

| Option | What it guarantees | Verdict |
| --- | --- | --- |
| **Naive dual-write** (commit, then call the engine) | Nothing on failure: a crash or an engine error between the two loses the update silently | Rejected. This was the design being replaced |
| **Index first**, then commit | The engine can hold a change Postgres rolled back, and search then serves a product that does not exist | Rejected. It inverts the source of truth |
| **2PC / XA** | Atomic commit across both stores, in theory | Rejected. Elasticsearch is not an XA resource, and a coordinator would make every catalog write wait on search availability |
| **Saga with compensation** | Each step undone on failure | Rejected. There is nothing to compensate: the index should follow Postgres, not veto it |
| **Transactional outbox** | The event commits with the write or not at all; delivery is at-least-once and retried | **Chosen.** The outbox, relay, queue, retry ladder and DLQ already run for orders and payments |
| **CDC** (Debezium on the WAL, including the outbox router) | The same guarantee, read from the log instead of polled | Rejected for now. It needs Kafka Connect and a replication slot, operational weight a single-store project does not need. It is the next step if polling becomes the bottleneck (below) |
| **Log first / listen to yourself** (write the event, derive both stores from it) | One ordered log feeds Postgres and the index alike | Rejected. It moves the source of truth off Postgres and rewrites every catalog write path |
| **Periodic reconciliation only** | Eventual repair on a timer | Rejected as the primary path: staleness is bounded by the sweep interval, and each sweep scans the whole catalog. The full rebuild covers the rare case it would serve |

## Decision

A transactional outbox with thin events, applied through versioned writes the engine itself orders.

- **Version in the row.** Every write that changes what a product document shows increments `products.search_version` and appends a `catalog.product.changed` outbox row in the same transaction ([`drizzle-catalog-admin.repository.ts`](../apps/api/src/modules/catalog/infrastructure/drizzle-catalog-admin.repository.ts)).
- **Thin events, re-read at consume time.** The event carries only the product id. The worker reads the product as it is now and writes it with `version_type: external` ([`product-search-sync.service.ts`](../apps/api/src/modules/catalog/application/services/product-search-sync.service.ts), [`elasticsearch-catalog-search.adapter.ts`](../apps/api/src/modules/catalog/infrastructure/search/elasticsearch-catalog-search.adapter.ts)). The engine refuses any version at or below the one it holds, so a late, repeated or reordered delivery is a no-op instead of a regression. The inbox is not what makes it idempotent: the handler runs before the claim, on every delivery.
- **Tombstones, not deletes.** A product that leaves the public projection is stored as a versioned document search never matches. A delete would forget the version, and a stale write arriving after it would recreate the product.
- **Category renames fan out in the worker.** A rename appends one `catalog.category.renamed` row. The worker bumps and rewrites the category's products in pages of 500, so the rename transaction stays small whatever the category holds.
- **Rebuilds go through a second alias.** `search:reindex` fills a fresh index while live writes reach both it and the one search reads, then moves the `products` alias in one atomic call. The rebuild alias doubles as the lock ([`reindex-runner.ts`](../apps/api/src/modules/catalog/infrastructure/search/reindex-runner.ts)).
- **Catalog jobs yield.** They carry a BullMQ priority, so a burst of catalog events queues behind order and payment work, and they share the long retry ladder with `order.paid` ([`queue.constants.ts`](../apps/api/src/shared/messaging/queue/queue.constants.ts)). Every engine call the app makes runs behind a circuit breaker, one for reads and one for writes, so a write-side fault never blanks search.

## Invariants

- A catalog write committed means its event committed.
- The engine never accepts an older version of a document than the one it holds.
- An archived product never reappears in search, whatever arrives late, including during a rebuild.

## Operational consequences

- **A database restore rewinds `search_version`.** The engine then holds versions the database no longer reaches and refuses every later write to those products until they catch up. A rebuild must follow any restore ([RUNBOOK](../RUNBOOK.md#rebuild-the-search-index)).
- **The retry ladder is shared with `order.paid`.** Tuning `ORDER_PAID_CONSUMER_*` moves both. An event still failing past the horizon (about 33 minutes) lands in the DLQ, and replaying it is always safe.
- **Search lags writes** by the relay's poll interval plus the engine's refresh interval, about 1 to 2 seconds. Search is not read-your-writes.
- **Elasticsearch costs memory.** With a 512 MB heap the node holds about 1 GiB idle and more during a rebuild, against a 1.5 GB budget on Railway.
- **The index holds tombstones** for every product outside the public projection. The rebuild writes them too.

## When this stops being right

- **Several consumers of catalog changes, or write volume where polling the outbox is the bottleneck.** Move to CDC with the Debezium outbox router. The handlers and the event envelope survive; only the relay changes.
- **Catalog jobs delaying other work, or the reverse.** Give catalog events a queue and a worker of their own instead of a priority on the shared one.
