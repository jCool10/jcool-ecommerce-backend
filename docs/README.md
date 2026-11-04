# Documentation route

Code owns **what** and **how**. These documents own only **why** and **where** — decisions, rejected alternatives, domain rules and navigation that the source cannot state about itself. Anything a reader could learn by opening the executable owner is a pointer here, not a paragraph.

## Authority

| Surface | Owns | Go here when you need |
| --- | --- | --- |
| [`README.md`](../README.md) | Public entry, kept short: product intent and non-goals, the four invariants, the topology map, one line per engineering highlight, the test tiers, a performance summary, one line per known limit, and the map of these documents. Detail lives in the documents below, never here | The system at a glance |
| [`engineering-highlights.md`](./engineering-highlights.md) | Each hard problem, the approach taken and the file to open; the checkout sequence; measured performance; observability; how the tests run on real infrastructure | The file to open for an engineering highlight, or the evidence behind a README claim |
| [`local-development.md`](./local-development.md) | What the README's Quick start leaves out: setup notes, ports, how `pnpm dev` and the workspace build behave, the full stack in Compose, the local observability stack, running the test tiers, and the `pnpm` scripts | To run, test or script the system on one machine |
| [`project-overview-pdr.md`](./project-overview-pdr.md) | Domain glossary and the business rules the code enforces | The exact meaning of a domain term, or which constant owns a business rule |
| [`system-architecture.md`](./system-architecture.md) | Service boundaries, data ownership, the bounded contexts, the layering contract, the auth trust flow, the checkout and settlement sequence, the decision ledger — each durable choice with its rejected alternatives and revisit trigger — and the known-limits ledger | To change a boundary, to judge whether a past decision still fits, or to know why a gap is still open |
| [`code-standards.md`](./code-standards.md) | Contribution constraints: gates, how fences are treated, where a test belongs, migrations, logging, API conventions, commits | To change the code and have the change accepted |
| [`codebase-summary.md`](./codebase-summary.md) | Navigation: the project layout, entry points, CLIs, schemas, config, test tiers, infra and deploy config, package roles | To find where something lives |
| [`deployment-guide.md`](./deployment-guide.md) | Environments, what owns each deploy target's config, the image, CI, CD and shutdown, and where the rest of the pipeline's reasoning is recorded | To change how or where the system deploys |
| [`project-roadmap.md`](./project-roadmap.md) | Intended direction that has not shipped | To know what is planned, as distinct from what is live |
| [`diagrams/`](./diagrams) | The diagrams `system-architecture.md`, `engineering-highlights.md` and the order-service's README embed: one typed JSON IR per diagram (the source), compiled by the `ak-diagram` skill's compiler into `<name>.svg` and `<name>-dark.svg`. Edit the JSON, never the SVG, then run `node scripts/build-doc-diagrams.mjs` (`AK_DIAGRAM_COMPILER` points it at a compiler outside `~/.claude/skills`). The same compiler's `--format html` turns one IR into an interactive reader | To change or add a diagram |
| [`RUNBOOK.md`](../RUNBOOK.md) | Manual operator procedures with consequences | To perform an operation against a live system |
| [`apps/api/README.md`](../apps/api/README.md), [`apps/id-service/README.md`](../apps/id-service/README.md), [`apps/user-service/README.md`](../apps/user-service/README.md), [`apps/inventory-service/README.md`](../apps/inventory-service/README.md), [`apps/payment-service/README.md`](../apps/payment-service/README.md), [`apps/order-service/README.md`](../apps/order-service/README.md) | Each service's API, configuration and published contracts; the api's also holds the error envelope and the conventions every route shares | To call or configure that service |
| [`.env.example`](../.env.example), [`apps/user-service/.env.example`](../apps/user-service/.env.example), [`apps/inventory-service/.env.example`](../apps/inventory-service/.env.example), [`apps/payment-service/.env.example`](../apps/payment-service/.env.example) | The commented reference for the api's, the user-service's, the inventory-service's and the payment-service's environment variables; the validators in each app's config are the final word | To configure an environment |
| `/docs` (Swagger UI) | The always-current HTTP contract, generated from the code | The exact request and response shape of a route |

## Route

The files above follow the classic layout. `design-guidelines.md` is deliberately absent: this is a backend with no UI, and its interface conventions are HTTP conventions, owned by [`code-standards.md`](./code-standards.md). Keep these filenames when updating; add a file only when a real information boundary appears that no surface above owns, and record it in the table.

## Not documentation authority

`plans/` holds plans, phase files and audit reports. It is gitignored and local: stateful records of a decision at a point in time, never linked from these documents or cited as current truth. A completed phase does not make one evergreen.

## Adding or changing a document

Apply the deletion test to every sentence before it is written. If an agent reading the executable owner would learn the sentence anyway, replace it with a pointer to that owner. Never hand-maintain a count, a file list or a copy of another document's contents list; link to the owner or give the command that discovers it.
