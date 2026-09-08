// For wiring only: this pulls the Drizzle adapter and, through it, OpenTelemetry, so domain and
// application code must import the port by its deep path (enforced by `messaging-port-only-from-core`).
// The queue is kept off this barrel deliberately — nothing outside this package should hold a Queue,
// and keeping bullmq out means app-level wiring doesn't pull the client library.
export * from './messaging.module';
export * from './outbox/outbox-writer.port';
