// Barrel for drizzle-kit config + the `DrizzleDB = NodePgDatabase<typeof schema>`
// generic. Table ownership lives in each module's `infrastructure/schema/`; this
// re-export exists only so drizzle-kit has one schema entry and the generic type
// stays a single import. It is a tooling boundary, NOT a shared data model —
// cross-context code must never reach a table through it.
export * from '../../../../modules/catalog/infrastructure/schema/catalog.schema';
export * from '../../../../modules/user/infrastructure/schema/user.schema';
