# Documentation route

Code owns **what** and **how**. These documents own only **why** and **where** — decisions, rejected alternatives, domain rules and navigation that the source cannot state about itself. Anything a reader could learn by opening the executable owner is a pointer here, not a paragraph.

## Authority

| Surface | Owns | Go here when you need |
| --- | --- | --- |
| [`README.md`](../README.md) | Product intent and explicit non-goals, the four invariants that drive the design, the bounded-context map and layering contract, the route summary, measured performance, observability, and the known-limits ledger | The reason a design is the way it is, or the file to open for it |
| [`apps/id-service/README.md`](../apps/id-service/README.md) | The id-service API, how node ids are leased and fenced, its configuration and metrics | To call id-service, or to reason about why two replicas never issue the same id |
| [`RUNBOOK.md`](../RUNBOOK.md) | Manual operator procedures with consequences — key handling, backup and restore, reindex, DLQ replay, bucket reconciliation, retention, owed refunds, out-of-band migrations | To perform an operation against a live system |
| [`engineering-rules.md`](./engineering-rules.md) | Contribution constraints: which gates must pass, how the build fences are treated, where a new test belongs, migration and commit rules | To change the code and have the change accepted |
| [`logging-conventions.md`](./logging-conventions.md) | The single logger call shape, level semantics, and what is added to every line automatically | To write or review a log line |
| [`.env.example`](../.env.example) | The complete, commented reference for every environment variable | To configure an environment |
| `/docs` (Swagger UI) | The always-current HTTP contract, generated from the code | The exact request and response shape of a route |

The README's context table and the layering section are the entry point for navigation; nothing here duplicates them.

## Not documentation authority

These exist in the working tree and are deliberately not committed or cited as current truth:

- `plans/` — plans, phase files and audit reports. Stateful records of a decision at a point in time; a completed phase does not make one evergreen.
- `docs/test-dedup-backlog.md` — a stateful audit residue whose source reports no longer exist. The one durable rule it carried is recorded in [`engineering-rules.md`](./engineering-rules.md) under *Tests*.
- `docs/interview-*` and rendered `*.html` — personal study artifacts, unrelated to the service.

## Adding a document

Apply the deletion test to every sentence before it is written. If an agent reading the executable owner would learn the sentence anyway, replace it with a pointer to that owner. Add a new file only when a real information boundary exists that no surface above already owns, and record it in the table here so it can be found.
