// Barrel: transactional outbox (write side). For wiring only — it pulls the Drizzle adapter and,
// through it, OpenTelemetry, so domain/application must import the port by its deep path instead
// (enforced by `messaging-port-only-from-core`). The schema is reached through the drizzle-kit
// barrel, not from here — nothing outside this package should touch the table directly.
export * from './messaging.module';
export * from './outbox/outbox-writer.port';
