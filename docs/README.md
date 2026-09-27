# Documentation route

Code owns **what** and **how**. These documents own only **why** and **where** — decisions, rejected alternatives, domain rules and navigation that the source cannot state about itself. Anything a reader could learn by opening the executable owner is a pointer here, not a paragraph.

## Authority

| Surface | Owns | Go here when you need |
| --- | --- | --- |
| [`README.md`](../README.md) | Public entry: product intent and non-goals, the four invariants, the architecture map and layering contract, the route summary, testing tiers, measured performance, observability, and the known-limits ledger | The system at a glance, or the file to open for an engineering highlight |
| [`project-overview-pdr.md`](./project-overview-pdr.md) | Domain glossary and the business rules the code enforces | The exact meaning of a domain term, or which constant owns a business rule |
| [`system-architecture.md`](./system-architecture.md) | Service boundaries, data ownership, the auth trust flow, and the decision ledger — each durable choice with its rejected alternatives and revisit trigger | To change a boundary, or to judge whether a past decision still fits |
| [`code-standards.md`](./code-standards.md) | Contribution constraints: gates, how fences are treated, where a test belongs, migrations, logging, API conventions, commits | To change the code and have the change accepted |
| [`codebase-summary.md`](./codebase-summary.md) | Navigation: entry points, CLIs, schemas, config, test tiers, infra and deploy config, package roles | To find where something lives |
| [`deployment-guide.md`](./deployment-guide.md) | Environments, what owns each deploy target's config, and where the pipeline's reasoning is recorded | To change how or where the system deploys |
| [`project-roadmap.md`](./project-roadmap.md) | Intended direction that has not shipped | To know what is planned, as distinct from what is live |
| [`RUNBOOK.md`](../RUNBOOK.md) | Manual operator procedures with consequences | To perform an operation against a live system |
| [`apps/id-service/README.md`](../apps/id-service/README.md), [`apps/user-service/README.md`](../apps/user-service/README.md) | Each service's API, configuration and published contracts | To call or configure that service |
| [`.env.example`](../.env.example), [`apps/user-service/.env.example`](../apps/user-service/.env.example) | The complete, commented reference for every api and user-service environment variable | To configure an environment |
| `/docs` (Swagger UI) | The always-current HTTP contract, generated from the code | The exact request and response shape of a route |

## Route

The files above follow the classic layout. `design-guidelines.md` is deliberately absent: this is a backend with no UI, and its interface conventions are HTTP conventions, owned by [`code-standards.md`](./code-standards.md). Keep these filenames when updating; add a file only when a real information boundary appears that no surface above owns, and record it in the table.

## Not documentation authority

`plans/` holds plans, phase files and audit reports. It is gitignored and local: stateful records of a decision at a point in time, never linked from these documents or cited as current truth. A completed phase does not make one evergreen.

## Adding or changing a document

Apply the deletion test to every sentence before it is written. If an agent reading the executable owner would learn the sentence anyway, replace it with a pointer to that owner. Never hand-maintain a count, a file list or a copy of another document's contents list; link to the owner or give the command that discovers it.
